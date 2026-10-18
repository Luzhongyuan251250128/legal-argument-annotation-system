const express = require("express");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");
const { deactivateUserAccount } = require("./users");

const router = express.Router();

function parseRoles(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  return [];
}

// 仅系统管理员可访问
async function requireAdmin(req, res, next) {
  try {
    const [rows] = await pool.query(
      "SELECT roles FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    if (!rows[0]) return fail(res, "用户不存在", 401, 401);
    const roles = parseRoles(rows[0].roles);
    if (!roles.includes("admin"))
      return fail(res, "仅系统管理员可执行此操作", 403, 403);
    next();
  } catch (e) {
    fail(res, "权限检查失败：" + e.message, 500, 500);
  }
}

// 列出所有用户及权限状态
router.get("/users", authRequired, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, username, display_name, roles, teaching_role, status FROM users ORDER BY id",
    );
    const items = rows.map((r) => {
      const roles = parseRoles(r.roles);
      return {
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        teachingRole: r.teaching_role,
        status: r.status,
        roles,
        isAdmin: roles.includes("admin"),
        canCreate: roles.includes("creator") || roles.includes("admin"),
        canAnnotate: roles.includes("annotator"),
        canAdjudicate: roles.includes("adjudicator"),
      };
    });
    ok(res, { items });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 授予 / 收回某用户的创建任务权限
router.put(
  "/users/:id/creator",
  authRequired,
  requireAdmin,
  async (req, res) => {
    const targetId = Number(req.params.id);
    const grant = !!(req.body && req.body.grant);
    if (!targetId) return fail(res, "用户 ID 无效");
    try {
      const [rows] = await pool.query(
        "SELECT username, roles FROM users WHERE id = ? LIMIT 1",
        [targetId],
      );
      const user = rows[0];
      if (!user) return fail(res, "用户不存在");
      let roles = parseRoles(user.roles);
      if (roles.includes("admin") && !grant) {
        return fail(res, "系统管理员的创建任务权限不可收回");
      }
      const has = roles.includes("creator");
      if (grant && !has) roles.push("creator");
      if (!grant && has) roles = roles.filter((r) => r !== "creator");
      await pool.query("UPDATE users SET roles = ? WHERE id = ?", [
        JSON.stringify(roles),
        targetId,
      ]);
      try {
        await pool.query(
          "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload) VALUES (?, ?, ?, ?, ?)",
          [
            req.user.id,
            grant ? "user.creator.grant" : "user.creator.revoke",
            "user",
            targetId,
            JSON.stringify({
              targetUsername: user.username,
              byUsername: req.user.username,
            }),
          ],
        );
      } catch (_) {
        /* 审计失败不阻断 */
      }
      ok(res, {
        ok: true,
        userId: targetId,
        canCreate: grant || roles.includes("admin"),
        roles,
      });
    } catch (e) {
      fail(res, "更新失败：" + e.message);
    }
  },
);

// 获取审计日志（分页）
router.get("/audit-logs", authRequired, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(10, parseInt(req.query.pageSize, 10) || 20);
  const offset = (page - 1) * pageSize;

  try {
    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS total FROM audit_logs",
    );
    const total = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT a.id, a.user_id, u.display_name AS username, a.action, a.entity_type, a.entity_id, a.payload, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset],
    );

    const items = rows.map((r) => {
      let payload = r.payload;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          /* ignore */
        }
      }
      return {
        id: r.id,
        userId: r.user_id,
        username: r.username || "系统/未知",
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payload,
        createdAt: r.created_at,
      };
    });

    ok(res, { items, total, page, pageSize });
  } catch (e) {
    fail(res, "查询审计日志失败：" + e.message);
  }
});

// 管理员注销其他用户
router.post(
  "/users/:id/deactivate",
  authRequired,
  requireAdmin,
  async (req, res) => {
    const targetId = Number(req.params.id);
    if (!targetId) return fail(res, "用户 ID 无效");

    try {
      const [rows] = await pool.query(
        "SELECT username, roles FROM users WHERE id = ? LIMIT 1",
        [targetId],
      );
      if (!rows[0]) return fail(res, "用户不存在");

      // 检查目标用户是否为管理员
      let targetRoles = rows[0].roles;
      if (typeof targetRoles === "string") {
        try {
          targetRoles = JSON.parse(targetRoles);
        } catch {
          targetRoles = [];
        }
      }
      if (Array.isArray(targetRoles) && targetRoles.includes("admin")) {
        return fail(res, "系统管理员账号不可注销");
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        await deactivateUserAccount(conn, targetId);

        // 写审计
        await conn.query(
          "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload) VALUES (?, ?, ?, ?, ?)",
          [
            req.user.id,
            "user.deactivate",
            "user",
            targetId,
            JSON.stringify({ targetUsername: rows[0].username }),
          ],
        );
        await conn.commit();
        ok(res, { ok: true });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      fail(res, "注销失败：" + e.message);
    }
  },
);

module.exports = router;
