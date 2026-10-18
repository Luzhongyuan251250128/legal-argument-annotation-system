const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");
const { toUser } = require("./auth");

const router = express.Router();

// 用户列表：annotators / adjudicators 供前端选择人员
router.get("/", authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, username, display_name, roles, teaching_role FROM users WHERE status = 1",
    );
    const users = rows.map((r) => ({
      id: r.id,
      userId: r.id,
      name: r.display_name,
      shortName: (r.display_name || "").slice(0, 1),
      roles: (function () {
        try {
          return typeof r.roles === "string"
            ? JSON.parse(r.roles)
            : r.roles || [];
        } catch {
          return [];
        }
      })(),
    }));
    // 前端结构约定
    const isAdmin = (roles) => Array.isArray(roles) && roles.includes("admin");
    // 标注者候选：排除管理员
    const nonAdminUsers = users.filter((u) => !isAdmin(u.roles));
    const annotators = nonAdminUsers.map((u) => ({
      id: "u" + u.id,
      userId: u.id,
      name: u.name,
      shortName: u.shortName,
    }));
    // 裁定者候选：允许管理员
    const adjudicators = users.map((u) => ({
      id: "u" + u.id,
      userId: u.id,
      name: u.name,
      shortName: u.shortName,
    }));
    ok(res, { items: users, annotators, adjudicators });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 更新个人资料
router.put("/me", authRequired, async (req, res) => {
  const { displayName, email, phone, organization } = req.body || {};
  if (!displayName || !displayName.trim()) return fail(res, "显示名称不能为空");
  try {
    await pool.query(
      "UPDATE users SET display_name = ?, email = ?, phone = ?, organization = ? WHERE id = ?",
      [
        displayName.trim(),
        email || null,
        phone || null,
        organization || null,
        req.user.id,
      ],
    );
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    ok(res, toUser(rows[0]));
  } catch (e) {
    fail(res, "更新失败：" + e.message);
  }
});

// 修改密码
router.put("/me/password", authRequired, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return fail(res, "请填写完整");
  if (newPassword.length < 8) return fail(res, "新密码至少 8 位");
  try {
    const [rows] = await pool.query(
      "SELECT password_hash FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    const user = rows[0];
    if (!user) return fail(res, "用户不存在");
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return fail(res, "当前密码不正确");
    if (currentPassword === newPassword)
      return fail(res, "新密码不能与当前密码相同");
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [
      hash,
      req.user.id,
    ]);
    ok(res, { ok: true });
  } catch (e) {
    fail(res, "修改失败：" + e.message);
  }
});

// 核心注销逻辑（供个人注销和管理员注销复用）
async function deactivateUserAccount(conn, targetUserId) {
  // 1. 处理作为标注员的任务
  const [assigneeTasks] = await conn.query(
    "SELECT task_id FROM task_assignees WHERE user_id = ?",
    [targetUserId],
  );
  for (const row of assigneeTasks) {
    const tid = row.task_id;

    // 查该任务的总标注员数
    const [[{ cnt }]] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM task_assignees WHERE task_id = ?",
      [tid],
    );
    // 查该用户在该任务是否有已提交的版本
    const [[{ verCnt }]] = await conn.query(
      "SELECT COUNT(*) AS verCnt FROM annotation_versions WHERE task_id = ? AND annotator_id = ? AND status IN ('submitted', 'final')",
      [tid, targetUserId],
    );
    // 查任务本身状态
    const [[task]] = await conn.query(
      "SELECT annotation_submitted FROM tasks WHERE id = ?",
      [tid],
    );

    // 规则：唯一标注员 且 未标注（未提交版本且未进入裁定）
    if (
      cnt === 1 &&
      verCnt === 0 &&
      (!task || task.annotation_submitted === 0)
    ) {
      // 将任务退回待创建状态（重置为草稿，保留文书原文）
      await conn.query("DELETE FROM exports WHERE task_id = ?", [tid]);
      await conn.query("DELETE FROM adjudications WHERE task_id = ?", [tid]);
      await conn.query("DELETE FROM annotation_versions WHERE task_id = ?", [
        tid,
      ]);
      await conn.query("DELETE FROM task_assignees WHERE task_id = ?", [tid]);
      await conn.query("DELETE FROM task_adjudicators WHERE task_id = ?", [
        tid,
      ]);
      await conn.query(
        `UPDATE tasks 
         SET is_created = 0, 
             annotation_submitted = 0, 
             adjudicated = 0, 
             final_annotation_version_id = NULL, 
             labels_json = NULL 
         WHERE id = ?`,
        [tid],
      );
      continue;
    } else {
      // 否则：仅移除该用户的关联和数据
      await conn.query(
        "DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?",
        [tid, targetUserId],
      );
      await conn.query(
        "DELETE FROM annotation_versions WHERE task_id = ? AND annotator_id = ?",
        [tid, targetUserId],
      );

      // 重算该任务 annotation_submitted
      if (task && task.annotation_submitted === 0) {
        const [[cnt2]] = await conn.query(
          `SELECT 
             (SELECT COUNT(*) FROM task_assignees WHERE task_id = ?) AS total,
             (SELECT COUNT(DISTINCT av.annotator_id) FROM annotation_versions av JOIN task_assignees ta ON ta.task_id = av.task_id AND ta.user_id = av.annotator_id WHERE av.task_id = ? AND av.status IN ('submitted','final')) AS submitted`,
          [tid, tid],
        );
        const allSubmitted =
          Number(cnt2.total) > 0 &&
          Number(cnt2.submitted) >= Number(cnt2.total);
        if (allSubmitted) {
          await conn.query(
            "UPDATE tasks SET annotation_submitted = 1 WHERE id = ?",
            [tid],
          );
        }
      }
    }
  }

  // 2. 禁用账号并释放用户名（逻辑注销）
  const [adjudicatorTasks] = await conn.query(
    "SELECT task_id FROM task_adjudicators WHERE user_id = ?",
    [targetUserId],
  );
  for (const row of adjudicatorTasks) {
    await conn.query(
      "DELETE FROM task_adjudicators WHERE task_id = ? AND user_id = ?",
      [row.task_id, targetUserId],
    );
  }

  // 3. 禁用账号并释放用户名（逻辑注销）
  await conn.query(
    'UPDATE users SET status = 0, username = CONCAT("deleted_", id, "_", username) WHERE id = ?',
    [targetUserId],
  );
}

// 个人注销
router.post("/me/deactivate", authRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 检查当前用户是否为管理员
    const [userRows] = await conn.query(
      "SELECT roles FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    let roles = userRows[0] && userRows[0].roles;
    if (typeof roles === "string") {
      try {
        roles = JSON.parse(roles);
      } catch {
        roles = [];
      }
    }
    if (Array.isArray(roles) && roles.includes("admin")) {
      await conn.rollback();
      return fail(res, "系统管理员账号不可注销");
    }

    await deactivateUserAccount(conn, req.user.id);
    await conn.commit();
    ok(res, { ok: true });
  } catch (e) {
    await conn.rollback();
    fail(res, "注销失败：" + e.message);
  } finally {
    conn.release();
  }
});

module.exports = router;
module.exports.deactivateUserAccount = deactivateUserAccount;
