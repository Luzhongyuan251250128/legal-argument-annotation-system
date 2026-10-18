const jwt = require("jsonwebtoken");
const pool = require("../db");
const { unauthorized, fail } = require("../utils/response");

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || "7d" },
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return unauthorized(res, "未登录");
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await pool.query(
      "SELECT status FROM users WHERE id = ? LIMIT 1",
      [payload.uid],
    );
    if (!rows[0] || rows[0].status !== 1) {
      return unauthorized(res, "账号已注销或禁用");
    }
    req.user = { id: payload.uid, username: payload.username };
    next();
  } catch (e) {
    return unauthorized(res, "登录已过期");
  }
}

async function creatorRequired(req, res, next) {
  try {
    const [rows] = await pool.query(
      "SELECT roles FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    if (!rows[0]) return unauthorized(res, "用户不存在");
    let roles = rows[0].roles;
    if (typeof roles === "string") {
      try {
        roles = JSON.parse(roles);
      } catch {
        roles = [];
      }
    }
    if (!Array.isArray(roles)) roles = [];
    if (!roles.includes("creator") && !roles.includes("admin")) {
      return fail(
        res,
        "当前账号无创建任务权限，请联系系统管理员授予。",
        403,
        403,
      );
    }
    next();
  } catch (e) {
    fail(res, "权限检查失败：" + e.message, 500, 500);
  }
}

module.exports = { signToken, authRequired, creatorRequired };
