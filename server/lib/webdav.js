"use strict";
/**
 * 极简 WebDAV 客户端（零依赖，Node 内置 https/http）。
 *
 * 为什么不用 fetch：PROPFIND / MKCOL / MOVE 是非标准方法，undici 会拒一部分；
 * 而且我们要精确控制 Basic Auth、超时、Link 分页、503 退避。
 *
 * 坚果云要点（与 obsidian-nutstore-sync 的实现一致）：
 *   - 端点默认 https://dav.jianguoyun.com/dav/（企业版可自定义 baseUrl）
 *   - 认证：Basic base64(账号邮箱:第三方应用密码)
 *   - PROPFIND Depth: 1 列目录，结果可能分页（响应头 Link: <...>; rel="next"）
 *   - 目录在 resourcetype 里带 <collection/>
 *   - 时间只到秒 → 比较用秒级容差（见 decide.js）
 *   - 高频请求会 503/429，需要退避重试
 *
 * ⚠️ 重试**不能**放在并发闸门内部递归（会自己等自己而死锁）。
 *    结构是：_send（限流 + 单次请求） ← _withRetry（退避重试） ← 公开方法。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");

const DEFAULT_ENDPOINT = "https://dav.jianguoyun.com/dav";

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop>
<displayname/><resourcetype/><getlastmodified/><getcontentlength/><getcontenttype/>
</prop></propfind>`;

/** XML 实体解码（href 里主要是 &amp; 与数字实体）。 */
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/** 取某个标签（允许任意命名空间前缀）的第一段内容。 */
function pickTag(text, tag) {
  const re = new RegExp(
    "<(?:[\\w.-]+:)?" + tag + "\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?" + tag + ">",
    "i",
  );
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * 解析 207 Multi-Status。
 * @returns {Array<{href:string,path:string,isDir:boolean,mtime:number,size:number}>}
 *          path 相对 endpoint 根，不带前导 /。
 */
function parseMultistatus(xml, endpointPath) {
  const out = [];
  const blockRe = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  let m;
  while ((m = blockRe.exec(xml))) {
    const block = m[1];
    const hrefRaw = pickTag(block, "href");
    if (!hrefRaw) continue;
    const href = decodeXmlEntities(hrefRaw).trim();
    const isDir = /<(?:[\w.-]+:)?collection\b/i.test(block);
    const mtimeRaw = pickTag(block, "getlastmodified");
    const sizeRaw = pickTag(block, "getcontentlength");
    const mtime = mtimeRaw ? Date.parse(decodeXmlEntities(mtimeRaw).trim()) : NaN;

    let p = href;
    try {
      p = decodeURIComponent(new URL(href, "http://x").pathname);
    } catch (_) {
      p = decodeURIComponent(href);
    }
    const base = String(endpointPath || "").replace(/\/+$/, "");
    if (base && (p === base || p.startsWith(base + "/"))) p = p.slice(base.length);
    p = p.replace(/^\/+/, "").replace(/\/+$/, "");

    out.push({
      href,
      path: p,
      isDir,
      mtime: Number.isFinite(mtime) ? mtime : 0,
      size: sizeRaw ? parseInt(decodeXmlEntities(sizeRaw), 10) || 0 : 0,
    });
  }
  return out;
}

/** 从 Link 头里取 rel="next"。 */
function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = String(linkHeader).match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
  return m ? m[1] : null;
}

/** 逐段 encodeURIComponent，保留斜杠。 */
function encodePath(p) {
  return String(p || "")
    .split("/")
    .filter((s) => s !== "")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function joinUrl(base, rel) {
  const b = String(base || "").replace(/\/+$/, "");
  const r = encodePath(rel);
  return r ? b + "/" + r : b + "/";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 并发闸门。 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const job = queue.shift();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

class WebDAVError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "WebDAVError";
    this.status = status || 0;
    this.body = body || "";
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

class WebDAVClient {
  constructor(opts) {
    const o = opts || {};
    this.baseUrl = String(o.baseUrl || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new WebDAVError("服务地址必须以 http:// 或 https:// 开头：" + this.baseUrl);
    }
    this.username = String(o.username || "");
    this.password = String(o.password || "");
    if (!this.username || !this.password) {
      throw new WebDAVError(
        "缺少坚果云账号或应用密码。请填「账号邮箱 + 第三方应用密码」（不是登录密码）。",
      );
    }
    this.timeoutMs = o.timeoutMs || 45000;
    this.retries = o.retries == null ? 3 : o.retries;
    this.retryBaseMs = o.retryBaseMs == null ? 1200 : o.retryBaseMs;
    this.minGapMs = o.minGapMs == null ? 0 : o.minGapMs;
    this._lastAt = 0;
    this._limit = createLimiter(Math.max(1, Math.min(8, o.concurrency || 3)));
    this._auth = "Basic " + Buffer.from(this.username + ":" + this.password, "utf8").toString("base64");
    this.endpointPath = (() => {
      try {
        return new URL(this.baseUrl).pathname.replace(/\/+$/, "");
      } catch (_) {
        return "";
      }
    })();
  }

  /** 单次请求（受并发闸门约束）。absUrl 可以是绝对 URL（分页）或相对路径。 */
  _send(method, target, body, headers) {
    const absUrl = /^https?:\/\//i.test(target) ? target : joinUrl(this.baseUrl, target);
    const u = new URL(absUrl);
    const lib = u.protocol === "http:" ? http : https;
    return this._limit(() => {
      const gate =
        this.minGapMs > 0
          ? (async () => {
              const wait = this._lastAt + this.minGapMs - Date.now();
              if (wait > 0) await sleep(wait);
              this._lastAt = Date.now();
            })()
          : Promise.resolve();
      return gate.then(
        () =>
          new Promise((resolve, reject) => {
            const req = lib.request(
              {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === "http:" ? 80 : 443),
                path: u.pathname + u.search,
                method,
                headers: Object.assign(
                  { Authorization: this._auth, "User-Agent": "notrat-nutstore/1.0", Accept: "*/*" },
                  headers || {},
                ),
                timeout: this.timeoutMs,
              },
              (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                  resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                  }),
                );
              },
            );
            req.on("timeout", () => req.destroy(new Error("请求超时（" + this.timeoutMs + "ms）：" + absUrl)));
            req.on("error", reject);
            if (body) req.write(body);
            req.end();
          }),
      );
    });
  }

  /** 带退避重试的请求。重试发生在闸门**之外**，不会自锁。 */
  async _withRetry(method, target, body, headers) {
    let lastErr = null;
    for (let n = 0; n <= this.retries; n++) {
      try {
        const res = await this._send(method, target, body, headers);
        if (RETRYABLE.has(res.status) && n < this.retries) {
          await sleep(this.retryBaseMs * Math.pow(2, n));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (n >= this.retries) break;
        await sleep(this.retryBaseMs * Math.pow(2, n));
      }
    }
    throw lastErr || new WebDAVError("请求失败（重试 " + this.retries + " 次）");
  }

  /** 状态码 → 人话。 */
  _expect(res, what) {
    if (res.status >= 200 && res.status < 300) return res;
    const bodyText = res.body ? res.body.toString("utf8").slice(0, 300) : "";
    const hints = {
      401: "账号或应用密码不对（密码必须是坚果云「第三方应用密码」，不是登录密码）",
      403: "没有该目录权限，或请求被拒绝",
      404: "路径不存在",
      409: "父目录不存在（WebDAV 不会自动建父目录）",
      423: "文件被锁定",
      429: "请求太频繁（坚果云有频率限制），稍后重试或调低并发",
      503: "云端暂不可用或请求太频繁，稍后重试或调低并发",
      507: "云端空间不足",
    };
    const hint = hints[res.status] || "";
    throw new WebDAVError(
      what + " 失败：HTTP " + res.status + (hint ? " —— " + hint : "") + (bodyText ? " | " + bodyText : ""),
      res.status,
      bodyText,
    );
  }

  /** 列目录（Depth 1，自动跟随 Link 分页），剔除目录自身。 */
  async list(relPath) {
    const path = String(relPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
    let target = joinUrl(this.baseUrl, path);
    const seen = new Set();
    const items = [];
    let guard = 0;
    while (target && guard++ < 500) {
      const res = await this._withRetry("PROPFIND", target, PROPFIND_BODY, {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
        "Content-Length": Buffer.byteLength(PROPFIND_BODY),
      });
      this._expect(res, "列目录 " + (path || "/"));
      for (const it of parseMultistatus(res.body.toString("utf8"), this.endpointPath)) {
        if (it.path === path) continue;
        if (seen.has(it.path)) continue;
        seen.add(it.path);
        items.push(it);
      }
      target = nextLink(res.headers.link || res.headers.Link) || null;
    }
    return items;
  }

  async get(relPath) {
    const res = await this._withRetry("GET", relPath, null, {});
    this._expect(res, "下载 " + relPath);
    return res.body;
  }

  async put(relPath, buffer, contentType) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    const res = await this._withRetry("PUT", relPath, buf, {
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": buf.length,
    });
    this._expect(res, "上传 " + relPath);
    return { size: buf.length };
  }

  async remove(relPath) {
    const res = await this._withRetry("DELETE", relPath, null, {});
    if (res.status === 404) return { missing: true };
    this._expect(res, "删除远程 " + relPath);
    return { ok: true };
  }

  async mkdir(relPath) {
    const res = await this._withRetry("MKCOL", relPath, null, {});
    if (res.status === 405) return { existed: true };
    if (res.status === 409) {
      throw new WebDAVError("建目录失败：父目录不存在 —— " + relPath, 409);
    }
    this._expect(res, "建远程目录 " + relPath);
    return { ok: true };
  }

  /** 逐段 MKCOL（已存在跳过）。 */
  async mkdirp(relPath) {
    const parts = String(relPath || "").split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? cur + "/" + part : part;
      const r = await this.mkdir(cur);
      if (r.existed) continue;
    }
    return { ok: true };
  }

  /** 读单条属性；不存在返回 null。 */
  async stat(relPath) {
    const path = String(relPath || "").replace(/^\/+/, "");
    const res = await this._withRetry("PROPFIND", path, PROPFIND_BODY, {
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "0",
      "Content-Length": Buffer.byteLength(PROPFIND_BODY),
    });
    if (res.status === 404) return null;
    this._expect(res, "读取远程属性 " + (path || "/"));
    const items = parseMultistatus(res.body.toString("utf8"), this.endpointPath);
    return items[0] || null;
  }

  /** 连接测试。 */
  async test() {
    const items = await this.list("");
    return {
      ok: true,
      baseUrl: this.baseUrl,
      topLevel: items.length,
      sample: items.slice(0, 12).map((i) => ({ path: i.path, isDir: i.isDir, size: i.size })),
    };
  }
}

module.exports = {
  WebDAVClient,
  WebDAVError,
  parseMultistatus,
  nextLink,
  encodePath,
  joinUrl,
  decodeXmlEntities,
  createLimiter,
  sleep,
  DEFAULT_ENDPOINT,
};
