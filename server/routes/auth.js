const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { signToken, authRequired } = require("../middleware/auth");

const router = express.Router();

// 转换用户对象为前端格式
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    organization: row.organization,
    roles: safeParseJSON(row.roles, []),
    teachingRole: row.teaching_role,
  };
}

function safeParseJSON(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

// 登录
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, "请输入用户名和密码");
  try {
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE username = ? AND status = 1 LIMIT 1",
      [username],
    );
    const user = rows[0];
    if (!user) return fail(res, "用户名或密码不正确");
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return fail(res, "用户名或密码不正确");
    const token = signToken(user);
    ok(res, { token, user: toUser(user) });
  } catch (e) {
    fail(res, "登录失败：" + e.message);
  }
});

// 退出（无状态 JWT 无需服务端处理）
router.post("/logout", authRequired, (req, res) => ok(res, { ok: true }));

// 当前用户信息
router.get("/me", authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    ok(res, toUser(rows[0]));
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 注册：默认无任何角色
router.post("/register", async (req, res) => {
  const { username, displayName, password, teachingRole } = req.body || {};
  if (!username || !displayName || !password) return fail(res, "缺少必要字段");
  if (username.length < 3) return fail(res, "用户名至少 3 位");
  if (!/^[A-Za-z0-9_]+$/.test(username))
    return fail(res, "用户名仅支持字母、数字和下划线");
  if (password.length < 6) return fail(res, "密码至少 6 位");
  const role = teachingRole === "teacher" ? "teacher" : "student";
  try {
    const [exist] = await pool.query(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [username],
    );
    if (exist.length) return fail(res, "用户名已被占用");
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.query(
      "INSERT INTO users (username, password_hash, display_name, roles, teaching_role) VALUES (?, ?, ?, ?, ?)",
      [username, hash, displayName, JSON.stringify([]), role],
    );
    ok(res, {
      id: r.insertId,
      username,
      displayName,
      roles: [],
      teachingRole: role,
    });
  } catch (e) {
    fail(res, "注册失败：" + e.message);
  }
});

module.exports = router;
module.exports.toUser = toUser;
module.exports.safeParseJSON = safeParseJSON;
