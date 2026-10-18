const express = require("express");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// 标签体系（全局，用于配置与编辑时选择）
router.get("/", authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT code, name, parent_code, level, sort_order FROM labels WHERE enabled = 1 ORDER BY level, sort_order",
    );
    const primary = [],
      secondary = [],
      primaryCatalog = [],
      secondaryCatalog = [];
    rows.forEach((r) => {
      const item = { code: r.code, name: r.name, parentCode: r.parent_code };
      if (r.level === "primary") {
        primary.push(item);
        primaryCatalog.push(item);
      } else {
        secondary.push(item);
        secondaryCatalog.push(item);
      }
    });
    ok(res, { primary, secondary, primaryCatalog, secondaryCatalog });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 新增标签
router.post("/", authRequired, async (req, res) => {
  const { code, name, parentCode, level } = req.body || {};
  if (!code || !name || !level) return fail(res, "缺少必要字段");
  try {
    await pool.query(
      "INSERT INTO labels (code, name, parent_code, level, enabled) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1, name = VALUES(name), parent_code = VALUES(parent_code)",
      [code, name, parentCode || null, level],
    );
    ok(res, { ok: true });
  } catch (e) {
    fail(res, "新增失败：" + e.message);
  }
});

// 删除标签（软删除）
router.delete("/:code", authRequired, async (req, res) => {
  const { code } = req.params;
  try {
    await pool.query("UPDATE labels SET enabled = 0 WHERE code = ?", [code]);
    ok(res, { ok: true });
  } catch (e) {
    fail(res, "删除失败：" + e.message);
  }
});

module.exports = router;
