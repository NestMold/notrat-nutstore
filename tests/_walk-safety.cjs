"use strict";
/**
 * 远端遍历的自环防护测试 —— 打的是**真的 walkRemote**，不是复刻的副本。
 *
 * 为什么这件事要专门测：我们每天只有 600 次请求 / 30 分钟的额度，
 * 一旦遍历出现自环，几十秒就能把账号打到 503 限流。而自环的来源往往不在
 * 我们代码里 —— 任何一台行为不规范的 WebDAV 服务器（目录把自己当子目录返回、
 * 软链接成环、分页把同一条吐两次）都可能触发。
 *
 * 所以这里不测「我的解析函数对不对」，而是喂给 walkRemote 一个**故意会返回
 * 自己的假客户端**，断言遍历仍然能终止 —— 这测的是真实防线。
 *
 * 曾经的写法是「从已删除的 dump 脚本里复刻两段逻辑再断言」，
 * 那种测试恒为绿灯，等于没有。
 */
const path = require("path");

const planLib = require("../server/lib/plan.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("测试函数不能是 async（本文件用同步断言）");
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name + "\n      " + String((e && e.message) || e));
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name + "\n      " + String((e && e.message) || e));
  }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || "不相等") + "：实际 " + sa + "，期望 " + sb);
}
function ok(v, msg) {
  if (!v) throw new Error(msg || "断言失败");
}

/* ─────────────────────── 假客户端 ─────────────────────── */

/**
 * 造一个 WebDAV 客户端替身。
 *
 * tree 的 key 是相对路径（""=根），value 是子项数组。
 * 关键点：includeSelf=true 时，list() 会**把目录自身也返回**（模拟不规范的服务器）。
 */
function fakeClient(tree, opts) {
  const o = opts || {};
  const calls = [];
  return {
    calls,
    async list(relPath) {
      const rel = String(relPath || "").replace(/^\/+|\/+$/g, "");
      calls.push(rel);
      if (calls.length > 500) throw new Error("list 被调用了 500 次以上 —— 遍历没停");
      const children = tree[rel] || [];
      const out = [];
      // 目录自身（不规范服务器会这么干）
      if (o.includeSelf) out.push({ path: rel, isDir: true, size: 0, mtime: 1 });
      for (const c of children) {
        const p = rel ? rel + "/" + c.name : c.name;
        out.push({ path: p, isDir: !!c.dir, size: c.size || 0, mtime: c.mtime || 1 });
      }
      // 软链接成环：把某个「祖先」再返回一次
      if (o.loopTo) out.push({ path: o.loopTo, isDir: true, size: 0, mtime: 1 });
      return out;
    },
  };
}

/* ─────────────────────── 用例 ─────────────────────── */

(async () => {
  await testAsync("正常树：每个目录只列一次", async () => {
    const tree = {
      "": [{ name: "note.md" }, { name: "sub", dir: true }],
      sub: [{ name: "inner.md" }],
    };
    const c = fakeClient(tree);
    const r = await planLib.walkRemote(c, "", {});
    eq(c.calls.slice().sort(), ["", "sub"], "只列根与 sub");
    ok(r.map.has("note.md"), "根下的文件被收录");
    ok(r.map.has("sub/inner.md"), "子目录的文件被收录");
  });

  await testAsync("服务器把目录自身也返回：不会自环", async () => {
    const tree = {
      "": [{ name: "plugins", dir: true }],
      plugins: [{ name: "clawhub", dir: true }],
      "plugins/clawhub": [],
    };
    const c = fakeClient(tree, { includeSelf: true });
    const r = await planLib.walkRemote(c, "", {});
    eq(c.calls.slice().sort(), ["", "plugins", "plugins/clawhub"], "三个目录各列一次，没有重复");
    ok(r.stats.dirs >= 2, "目录被统计");
  });

  await testAsync("分页把同一条吐两次：不会重复入队", async () => {
    // list 每次返回同样的子目录 —— 模拟分页没去重
    let n = 0;
    const client = {
      async list() {
        n++;
        if (n > 300) throw new Error("自环：list 被调用 300 次");
        return [{ path: "a", isDir: true, size: 0, mtime: 1 }];
      },
    };
    // a 每次都说自己有子目录 a → 经典自环
    const r = await planLib.walkRemote(client, "", {});
    ok(n <= 3, "实际只列了 " + n + " 次就停下来了");
    ok(r.map.has("a"), "a 被收录一次");
  });

  await testAsync("软链接指回祖先：不无限展开", async () => {
    const tree = {
      "": [{ name: "docs", dir: true }],
      docs: [{ name: "readme.md" }],
    };
    const c = fakeClient(tree, { loopTo: "docs" });
    const r = await planLib.walkRemote(c, "", {});
    ok(c.calls.length <= 4, "list 次数 " + c.calls.length + " 在合理范围");
    ok(r.map.has("docs/readme.md"), "正常内容仍然被收录");
  });

  await testAsync("真实事故形状：plugins → clawhub 空目录", async () => {
    // 复刻 2026-10 那次真实自环：子目录把自己当子目录返回
    const tree = {
      "": [{ name: "note.md" }, { name: "plugins", dir: true }],
      plugins: [{ name: "clawhub", dir: true }, { name: "skillhub", dir: true }],
      "plugins/clawhub": [],
      "plugins/skillhub": [],
    };
    const c = fakeClient(tree, { includeSelf: true });
    const r = await planLib.walkRemote(c, "", {});
    eq(
      c.calls.slice().sort(),
      ["", "plugins", "plugins/clawhub", "plugins/skillhub"],
      "每个目录恰好列一次（原来这里会列到 51 次才被 503 打断）",
    );
    ok(r.stats.errors.length === 0, "没有错误记录");
  });

  await testAsync("目录数超上限会中止（最后一道保险）", async () => {
    // 无限深的链：每层只有一个子目录，路径各不相同 → seen 挡不住，只能靠上限
    // 上限注入成 20，避免真的跑两万层（那样路径字符串会平方级增长）
    const client = {
      async list(relPath) {
        const rel = String(relPath || "");
        return [{ path: rel ? rel + "/x" : "x", isDir: true, size: 0, mtime: 1 }];
      },
    };
    const r = await planLib.walkRemote(client, "", { maxDirs: 20 });
    ok(
      r.stats.errors.some((e) => /上限/.test(e.error)),
      "触发了上限保护：" + JSON.stringify(r.stats.errors.map((e) => e.error)),
    );
    ok(r.stats.propfinds <= 25, "实际只列了 " + r.stats.propfinds + " 个目录就止损");
  });

  await testAsync("单个目录读取失败不中断整棵树", async () => {
    let n = 0;
    const client = {
      async list(relPath) {
        n++;
        if (relPath === "bad") throw new Error("HTTP 500");
        if (relPath === "") return [{ path: "bad", isDir: true, size: 0, mtime: 1 }, { path: "good.md", size: 3, mtime: 1 }];
        return [{ path: "bad/inner.md", size: 1, mtime: 1 }];
      },
    };
    const r = await planLib.walkRemote(client, "", {});
    ok(r.stats.errors.length >= 1, "失败被记录");
    ok(r.map.has("good.md"), "同层的正常文件仍然被收录");
  });

  await testAsync("取消信号会真的停下", async () => {
    let n = 0;
    const client = {
      async list() {
        n++;
        return [{ path: "d" + n, isDir: true, size: 0, mtime: 1 }];
      },
    };
    let threw = null;
    try {
      await planLib.walkRemote(client, "", { shouldCancel: () => n >= 2 });
    } catch (e) {
      threw = e;
    }
    ok(threw && threw.code === "CANCELLED", "抛出了 CANCELLED");
  });

  console.log("\n远端遍历自环防护：" + passed + " 通过 / " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})();
