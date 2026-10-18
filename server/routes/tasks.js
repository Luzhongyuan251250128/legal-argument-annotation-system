const express = require("express");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired, creatorRequired } = require("../middleware/auth");

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

// 找出给定用户 ID 中拥有 admin 角色的人
async function findAdminUids(conn, uids) {
  const list = (uids || []).filter(Boolean);
  if (!list.length) return [];
  const [rows] = await conn.query(
    "SELECT id, roles FROM users WHERE id IN (?)",
    [list],
  );
  const adminIds = [];
  rows.forEach((r) => {
    let roles = r.roles;
    if (typeof roles === "string") {
      try {
        roles = JSON.parse(roles);
      } catch {
        roles = [];
      }
    }
    if (Array.isArray(roles) && roles.includes("admin")) adminIds.push(r.id);
  });
  return adminIds;
}

// 按“当前实际标注者集合”重算是否全部已提交；total > 0 且 submitted >= total 时置 annotation_submitted = 1
async function recalcAnnotationSubmitted(conn, taskId) {
  const [countRows] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM task_assignees WHERE task_id = ?) AS total,
       (SELECT COUNT(DISTINCT av.annotator_id)
          FROM annotation_versions av
          JOIN task_assignees ta
            ON ta.task_id = av.task_id AND ta.user_id = av.annotator_id
         WHERE av.task_id = ? AND av.status IN ('submitted','final')) AS submitted`,
    [taskId, taskId],
  );
  const total = Number(countRows[0].total) || 0;
  const submitted = Number(countRows[0].submitted) || 0;
  const allSubmitted = total > 0 && submitted >= total;
  await conn.query("UPDATE tasks SET annotation_submitted = ? WHERE id = ?", [
    allSubmitted ? 1 : 0,
    taskId,
  ]);
  return { total, submitted, allSubmitted };
}

// 将数据库行转成前端期望的结构
function toTask(row, assignees, adjudicatorIds) {
  return {
    id: row.id,
    taskCode: row.task_code,
    name: row.name,
    type: row.doc_type,
    docType: row.doc_type,
    caseType: row.case_type,
    detail: row.detail || "",
    sourceText: row.source_text || "",
    reasonText: row.reason_text || "",
    reasonStart: row.reason_start,
    reasonEnd: row.reason_end,
    labelsJson: row.labels_json,
    created: !!row.is_created,
    annotationSubmitted: !!row.annotation_submitted,
    adjudicated: !!row.adjudicated,
    finalAnnotationVersionId: row.final_annotation_version_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignees: assignees || [],
    adjudicatorIds: adjudicatorIds || [],
  };
}

async function attachAssignees(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const [assigneeRows] = await pool.query(
    "SELECT task_id, user_id FROM task_assignees WHERE task_id IN (?)",
    [ids],
  );
  const [adjRows] = await pool.query(
    "SELECT task_id, user_id FROM task_adjudicators WHERE task_id IN (?)",
    [ids],
  );
  const aMap = {},
    jMap = {};
  assigneeRows.forEach((r) => {
    (aMap[r.task_id] = aMap[r.task_id] || []).push("u" + r.user_id);
  });
  adjRows.forEach((r) => {
    (jMap[r.task_id] = jMap[r.task_id] || []).push("u" + r.user_id);
  });
  return tasks.map((t) => ({
    ...t,
    assignees: aMap[t.id] || [],
    adjudicatorIds: jMap[t.id] || [],
  }));
}

// 任务列表（全部）
router.get("/", authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM tasks ORDER BY updated_at DESC",
    );
    const tasks = rows.map((r) => toTask(r, [], []));
    const withPeople = await attachAssignees(tasks);
    ok(res, { items: withPeople });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 我的任务
// 获取某任务创建时锁定的标签集
router.get("/:id/labels", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  try {
    const [rows] = await pool.query(
      "SELECT labels_json FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    const row = rows[0];
    if (!row) return fail(res, "任务不存在");
    let snapshot = row.labels_json;
    if (typeof snapshot === "string") {
      try {
        snapshot = JSON.parse(snapshot);
      } catch {
        snapshot = null;
      }
    }
    if (!snapshot)
      return ok(res, { primary: [], secondary: [], locked: false });
    ok(res, {
      primary: snapshot.primary || [],
      secondary: snapshot.secondary || [],
      locked: true,
    });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});
router.get("/my", authRequired, async (req, res) => {
  try {
    const uid = req.user.id;
    const [rows] = await pool.query(
      `SELECT DISTINCT t.* FROM tasks t
       LEFT JOIN task_assignees a ON a.task_id = t.id
       LEFT JOIN task_adjudicators d ON d.task_id = t.id
       WHERE t.is_created = 1 AND (a.user_id = ? OR d.user_id = ?)
       ORDER BY t.updated_at DESC`,
      [uid, uid],
    );
    const tasks = rows.map((r) => toTask(r, [], []));
    const withPeople = await attachAssignees(tasks);
    ok(res, { items: withPeople });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 创建任务
// 支持两种语义：
// - 普通创建：is_created = 1
// - 草稿（上传/手动输入文书）：isDraft = true，is_created = 0
router.post("/", authRequired, creatorRequired, async (req, res) => {
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks) || !tasks.length) return fail(res, "缺少任务列表");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const createdItems = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const isDraft = !!t.isDraft;
      const isCreated = isDraft ? 0 : 1;

      let taskId = null;
      let existingName = null;

      // 已存在记录：已创建 → 跳过；草稿 → 转为正式任务（UPDATE，不新建）
      if (t.id && !isDraft) {
        const [existRows] = await conn.query(
          "SELECT id, is_created, name FROM tasks WHERE id = ? LIMIT 1",
          [t.id],
        );
        const exist = existRows[0];
        if (exist && exist.is_created === 1) {
          continue;
        }
        if (exist) {
          taskId = exist.id;
          existingName = exist.name;
          await conn.query(
            `UPDATE tasks
               SET name = ?, case_type = ?, detail = ?, is_created = 1
             WHERE id = ?`,
            [
              (t.name && String(t.name).trim()) ||
                existingName ||
                "未命名文书" + (i + 1),
              t.caseType || "ordinary",
              t.detail || "",
              taskId,
            ],
          );
        }
      }

      // 不存在（或草稿路径）才插入
      if (!taskId) {
        const code =
          t.taskCode ||
          "T" + Date.now() + Math.random().toString(36).slice(2, 6);
        const [r] = await conn.query(
          `INSERT INTO tasks
            (task_code, name, doc_type, case_type, detail, source_text, is_created, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code,
            (t.name && String(t.name).trim()) || "未命名文书" + (i + 1),
            t.docType || "TXT",
            t.caseType || "ordinary",
            t.detail || "",
            t.sourceText || "",
            isCreated,
            req.user.id,
          ],
        );
        taskId = r.insertId;
      }

      // 人员分配：先清空再插入（草稿可能已有人；也避免唯一键冲突）
      // 草稿阶段若已有人被移除，删除其标注记录
      const [oldAssigneeRows] = await conn.query(
        "SELECT user_id FROM task_assignees WHERE task_id = ?",
        [taskId],
      );
      const oldAssigneeUids = oldAssigneeRows.map((r) => r.user_id);
      const newAssigneeUids = (Array.isArray(t.assignees) ? t.assignees : [])
        .map((aid) => Number(String(aid).replace(/^u/, "")))
        .filter(Boolean);
      const taskAdminUids = await findAdminUids(conn, newAssigneeUids);
      if (taskAdminUids.length) {
        await conn.rollback();
        return fail(
          res,
          "管理员不可被选为标注者（用户 ID：" + taskAdminUids.join("、") + "）",
        );
      }
      if (!isDraft && !newAssigneeUids.length) {
        await conn.rollback();
        return fail(res, "创建任务至少需要一名标注人员");
      }
      const removedUids = oldAssigneeUids.filter(
        (u) => !newAssigneeUids.includes(u),
      );
      if (removedUids.length) {
        await conn.query(
          `DELETE FROM annotation_versions WHERE task_id = ? AND annotator_id IN (${removedUids
            .map(() => "?")
            .join(",")})`,
          [taskId, ...removedUids],
        );
      }

      await conn.query("DELETE FROM task_assignees WHERE task_id = ?", [
        taskId,
      ]);
      await conn.query("DELETE FROM task_adjudicators WHERE task_id = ?", [
        taskId,
      ]);

      if (Array.isArray(t.assignees)) {
        for (const aid of t.assignees) {
          const uid = Number(String(aid).replace(/^u/, ""));
          if (!uid) continue;
          await conn.query(
            "INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)",
            [taskId, uid],
          );
        }
      }
      if (Array.isArray(t.adjudicatorIds) && t.adjudicatorIds.length > 1) {
        await conn.rollback();
        return fail(res, "每个任务只允许一个裁定者");
      }
      if (Array.isArray(t.adjudicatorIds)) {
        const [assignRows] = await conn.query(
          "SELECT user_id FROM task_assignees WHERE task_id = ?",
          [taskId],
        );
        const existSet = new Set(assignRows.map((r) => r.user_id));
        for (const rid of t.adjudicatorIds) {
          const uid = Number(String(rid).replace(/^u/, ""));
          if (!uid) continue;
          if (existSet.has(uid)) continue; // 标注者优先
          await conn.query(
            "INSERT INTO task_adjudicators (task_id, user_id) VALUES (?, ?)",
            [taskId, uid],
          );
        }
      }

      // 正式任务（非草稿）：快照当前启用的标签
      if (!isDraft) {
        const [labelRows] = await conn.query(
          "SELECT code, name, parent_code, level, sort_order FROM labels WHERE enabled = 1 ORDER BY level, sort_order",
        );
        const primary = [],
          secondary = [];
        labelRows.forEach((r) => {
          const item = {
            code: r.code,
            name: r.name,
            parentCode: r.parent_code,
          };
          if (r.level === "primary") primary.push(item);
          else secondary.push(item);
        });
        await conn.query("UPDATE tasks SET labels_json = ? WHERE id = ?", [
          JSON.stringify({ primary, secondary }),
          taskId,
        ]);
      }

      const [rows] = await conn.query(
        "SELECT * FROM tasks WHERE id = ? LIMIT 1",
        [taskId],
      );
      createdItems.push(
        toTask(rows[0], t.assignees || [], t.adjudicatorIds || []),
      );
    }
    await conn.commit();
    const withPeople = await attachAssignees(createdItems);
    ok(res, { items: withPeople });
  } catch (e) {
    await conn.rollback();
    fail(res, "创建失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 重命名文书（仅允许尚未创建为任务的文书）
router.put("/:id", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const rawName = (req.body && req.body.name) || "";
  const name = String(rawName).trim();
  if (!taskId) return fail(res, "缺少任务 ID");
  if (!name) return fail(res, "名称不能为空");
  if (name.length > 255) return fail(res, "名称过长（最多 255 字符）");
  try {
    const [rows] = await pool.query(
      "SELECT is_created, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    if (!rows[0]) return fail(res, "文书不存在");
    if (rows[0].is_created === 1)
      return fail(res, "已创建为任务的文书不可重命名");
    if (rows[0].adjudicated === 1) return fail(res, "已裁定的文书不可重命名");
    await pool.query("UPDATE tasks SET name = ? WHERE id = ?", [name, taskId]);
    ok(res, { ok: true, id: taskId, name });
  } catch (e) {
    fail(res, "重命名失败：" + e.message);
  }
});
// 删除任务（回退为草稿）：仅未裁定的已创建任务可删除；文书保留，可重新创建任务
router.post("/:id/reset", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  if (!taskId) return fail(res, "任务 ID 无效");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [taskRows] = await conn.query(
      "SELECT id, name, created_by, is_created, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    const task = taskRows[0];
    if (!task) {
      await conn.rollback();
      return fail(res, "任务不存在");
    }
    if (task.is_created !== 1) {
      await conn.rollback();
      return fail(res, "只能删除已创建的任务");
    }
    if (task.adjudicated === 1) {
      await conn.rollback();
      return fail(res, "已裁定的任务不可删除");
    }
    const [userRows] = await conn.query(
      "SELECT roles FROM users WHERE id = ? LIMIT 1",
      [req.user.id],
    );
    const roles = parseRoles(userRows[0] && userRows[0].roles);
    const canCreate = roles.includes("creator") || roles.includes("admin");
    if (!canCreate) {
      await conn.rollback();
      return fail(res, "仅拥有创建任务权限的用户可删除未裁定任务");
    }

    await conn.query("DELETE FROM exports WHERE task_id = ?", [taskId]);
    await conn.query("DELETE FROM adjudications WHERE task_id = ?", [taskId]);
    // 级联删除 propositions / relations
    await conn.query("DELETE FROM annotation_versions WHERE task_id = ?", [
      taskId,
    ]);
    await conn.query("DELETE FROM task_assignees WHERE task_id = ?", [taskId]);
    await conn.query("DELETE FROM task_adjudicators WHERE task_id = ?", [
      taskId,
    ]);
    await conn.query(
      `UPDATE tasks
         SET is_created = 0,
             annotation_submitted = 0,
             adjudicated = 0,
             final_annotation_version_id = NULL,
             labels_json = NULL
       WHERE id = ?`,
      [taskId],
    );

    try {
      await conn.query(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload) VALUES (?, ?, ?, ?, ?)",
        [
          req.user.id,
          "task.reset",
          "task",
          taskId,
          JSON.stringify({
            name: task.name,
            createdBy: task.created_by,
            byUsername: req.user.username,
          }),
        ],
      );
    } catch (_) {
      /* 审计失败不阻断 */
    }

    await conn.commit();
    ok(res, { ok: true, id: taskId, name: task.name });
  } catch (e) {
    await conn.rollback();
    fail(res, "删除失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 更新任务的标注人员（替换式）
router.put("/:id/assignees", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const ids = (req.body && req.body.assigneeIds) || [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [taskRows] = await conn.query(
      "SELECT is_created, annotation_submitted, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    if (
      taskRows[0] &&
      (taskRows[0].annotation_submitted === 1 || taskRows[0].adjudicated === 1)
    ) {
      await conn.rollback();
      return fail(res, "任务已进入裁定阶段，不可修改标注人员");
    }
    // 查出原标注者，计算被移除者，删除其标注记录
    const [oldRows] = await conn.query(
      "SELECT user_id FROM task_assignees WHERE task_id = ?",
      [taskId],
    );
    const oldUids = oldRows.map((r) => r.user_id);

    const newUids = [];
    for (const aid of ids) {
      const uid = Number(String(aid).replace(/^u/, ""));
      if (!uid) continue;
      if (!newUids.includes(uid)) newUids.push(uid);
    }

    const adminUids = await findAdminUids(conn, newUids);
    if (adminUids.length) {
      await conn.rollback();
      return fail(
        res,
        "管理员不可被选为标注者（用户 ID：" + adminUids.join("、") + "）",
      );
    }

    if (!newUids.length && taskRows[0] && taskRows[0].is_created === 1) {
      await conn.rollback();
      return fail(res, "已创建任务至少需要保留一名标注人员");
    }

    const removedUids = oldUids.filter((u) => !newUids.includes(u));
    if (removedUids.length) {
      await conn.query(
        `DELETE FROM annotation_versions WHERE task_id = ? AND annotator_id IN (${removedUids
          .map(() => "?")
          .join(",")})`,
        [taskId, ...removedUids],
      );
    }

    await conn.query("DELETE FROM task_assignees WHERE task_id = ?", [taskId]);
    for (const uid of newUids) {
      await conn.query(
        "INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)",
        [taskId, uid],
      );
    }
    if (newUids.length) {
      await conn.query(
        `DELETE FROM task_adjudicators WHERE task_id = ? AND user_id IN (${newUids
          .map(() => "?")
          .join(",")})`,
        [taskId, ...newUids],
      );
    }

    const recalc = await recalcAnnotationSubmitted(conn, taskId);
    await conn.query("UPDATE tasks SET adjudicated = 0 WHERE id = ?", [taskId]);
    await conn.commit();
    ok(res, {
      ok: true,
      assigneeIds: ids,
      removedAnnotatorIds: removedUids,
      ...recalc,
    });
  } catch (e) {
    await conn.rollback();
    fail(res, "更新失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 更新任务的裁定者（替换式）
router.put("/:id/adjudicators", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const ids = (req.body && req.body.adjudicatorIds) || [];
  if (!Array.isArray(ids)) return fail(res, "裁定者数据格式错误");
  if (ids.length > 1) return fail(res, "每个任务只允许一个裁定者");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [taskRows] = await conn.query(
      "SELECT is_created, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    if (taskRows[0] && taskRows[0].adjudicated === 1) {
      await conn.rollback();
      return fail(res, "任务已裁定，不可修改裁定者");
    }
    const newAdjUids = [];
    for (const rid of ids) {
      const uid = Number(String(rid).replace(/^u/, ""));
      if (!uid) continue;
      if (!newAdjUids.includes(uid)) newAdjUids.push(uid);
    }

    // 这些裁定者若当前是标注者，会从标注者中移除，需删除其标注记录
    const [oldAssigneeRows] = await conn.query(
      "SELECT user_id FROM task_assignees WHERE task_id = ?",
      [taskId],
    );
    const oldAssigneeUids = oldAssigneeRows.map((r) => r.user_id);
    const removedUids = oldAssigneeUids.filter((u) => newAdjUids.includes(u));
    if (
      removedUids.length &&
      taskRows[0] &&
      taskRows[0].is_created === 1 &&
      oldAssigneeUids.length - removedUids.length === 0
    ) {
      await conn.rollback();
      return fail(
        res,
        "已创建任务至少需要保留一名标注人员；请先添加替代标注者，再将原标注者设为裁定者",
      );
    }
    if (removedUids.length) {
      await conn.query(
        `DELETE FROM annotation_versions WHERE task_id = ? AND annotator_id IN (${removedUids
          .map(() => "?")
          .join(",")})`,
        [taskId, ...removedUids],
      );
    }

    await conn.query("DELETE FROM task_adjudicators WHERE task_id = ?", [
      taskId,
    ]);
    for (const uid of newAdjUids) {
      await conn.query(
        "INSERT INTO task_adjudicators (task_id, user_id) VALUES (?, ?)",
        [taskId, uid],
      );
    }
    if (newAdjUids.length) {
      await conn.query(
        `DELETE FROM task_assignees WHERE task_id = ? AND user_id IN (${newAdjUids
          .map(() => "?")
          .join(",")})`,
        [taskId, ...newAdjUids],
      );
    }

    const recalc = await recalcAnnotationSubmitted(conn, taskId);
    await conn.query("UPDATE tasks SET adjudicated = 0 WHERE id = ?", [taskId]);
    await conn.commit();
    ok(res, {
      ok: true,
      adjudicatorIds: ids,
      removedAnnotatorIds: removedUids,
      ...recalc,
    });
  } catch (e) {
    await conn.rollback();
    fail(res, "更新失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 批量分配标注人员
router.post("/bulk-assign", authRequired, async (req, res) => {
  const { taskIds, assigneeIds } = req.body || {};
  if (!Array.isArray(taskIds) || !taskIds.length)
    return fail(res, "缺少任务列表");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [lockedRows] = await conn.query(
      "SELECT id FROM tasks WHERE id IN (?) AND (annotation_submitted = 1 OR adjudicated = 1)",
      [taskIds],
    );
    if (lockedRows.length) {
      await conn.rollback();
      return fail(
        res,
        "任务 " +
          lockedRows.map((r) => r.id).join("、") +
          " 已进入裁定阶段，不可修改标注人员",
      );
    }

    const bulkUids = [];
    for (const aid of assigneeIds || []) {
      const uid = Number(String(aid).replace(/^u/, ""));
      if (!uid) continue;
      if (!bulkUids.includes(uid)) bulkUids.push(uid);
    }
    const bulkAdminUids = await findAdminUids(conn, bulkUids);
    if (bulkAdminUids.length) {
      await conn.rollback();
      return fail(
        res,
        "管理员不可被选为标注者（用户 ID：" + bulkAdminUids.join("、") + "）",
      );
    }

    if (!bulkUids.length) {
      const [createdRows] = await conn.query(
        "SELECT id FROM tasks WHERE id IN (?) AND is_created = 1",
        [taskIds],
      );
      if (createdRows.length) {
        await conn.rollback();
        return fail(
          res,
          "任务 " +
            createdRows.map((r) => r.id).join("、") +
            " 已创建，至少需要保留一名标注人员",
        );
      }
    }

    for (const tid of taskIds) {
      const [oldRows] = await conn.query(
        "SELECT user_id FROM task_assignees WHERE task_id = ?",
        [tid],
      );
      const oldUids = oldRows.map((r) => r.user_id);

      const newUids = [];
      for (const aid of assigneeIds || []) {
        const uid = Number(String(aid).replace(/^u/, ""));
        if (!uid) continue;
        if (!newUids.includes(uid)) newUids.push(uid);
      }

      const removedUids = oldUids.filter((u) => !newUids.includes(u));
      if (removedUids.length) {
        await conn.query(
          `DELETE FROM annotation_versions WHERE task_id = ? AND annotator_id IN (${removedUids
            .map(() => "?")
            .join(",")})`,
          [tid, ...removedUids],
        );
      }

      await conn.query("DELETE FROM task_assignees WHERE task_id = ?", [tid]);
      for (const uid of newUids) {
        await conn.query(
          "INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)",
          [tid, uid],
        );
      }
      if (newUids.length) {
        await conn.query(
          `DELETE FROM task_adjudicators WHERE task_id = ? AND user_id IN (${newUids
            .map(() => "?")
            .join(",")})`,
          [tid, ...newUids],
        );
      }

      await recalcAnnotationSubmitted(conn, tid);
      await conn.query("UPDATE tasks SET adjudicated = 0 WHERE id = ?", [tid]);
    }
    await conn.commit();
    ok(res, { updated: taskIds.length });
  } catch (e) {
    await conn.rollback();
    fail(res, "批量分配失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 批量分配裁定者
router.post("/bulk-adjudicators", authRequired, async (req, res) => {
  const { taskIds, adjudicatorIds } = req.body || {};
  if (!Array.isArray(taskIds) || !taskIds.length)
    return fail(res, "缺少任务列表");
  if (!Array.isArray(adjudicatorIds)) return fail(res, "裁定者数据格式错误");
  if (adjudicatorIds.length > 1) return fail(res, "每个任务只允许一个裁定者");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [lockedRows] = await conn.query(
      "SELECT id FROM tasks WHERE id IN (?) AND adjudicated = 1",
      [taskIds],
    );
    if (lockedRows.length) {
      await conn.rollback();
      return fail(
        res,
        "任务 " +
          lockedRows.map((r) => r.id).join("、") +
          " 已裁定，不可修改裁定者",
      );
    }
    for (const tid of taskIds) {
      const newAdjUids = [];
      for (const rid of adjudicatorIds || []) {
        const uid = Number(String(rid).replace(/^u/, ""));
        if (!uid) continue;
        if (!newAdjUids.includes(uid)) newAdjUids.push(uid);
      }

      const [oldAssigneeRows] = await conn.query(
        "SELECT user_id FROM task_assignees WHERE task_id = ?",
        [tid],
      );
      const oldAssigneeUids = oldAssigneeRows.map((r) => r.user_id);
      const removedUids = oldAssigneeUids.filter((u) => newAdjUids.includes(u));
      if (removedUids.length) {
        const [createdRows] = await conn.query(
          "SELECT id FROM tasks WHERE id = ? AND is_created = 1 LIMIT 1",
          [tid],
        );
        if (
          createdRows.length &&
          oldAssigneeUids.length - removedUids.length === 0
        ) {
          await conn.rollback();
          return fail(
            res,
            "任务 " +
              tid +
              " 已创建，至少需要保留一名标注人员；请先添加替代标注者，再将原标注者设为裁定者",
          );
        }
        await conn.query(
          `DELETE FROM annotation_versions WHERE task_id = ? AND annotator_id IN (${removedUids
            .map(() => "?")
            .join(",")})`,
          [tid, ...removedUids],
        );
      }

      await conn.query("DELETE FROM task_adjudicators WHERE task_id = ?", [
        tid,
      ]);
      for (const uid of newAdjUids) {
        await conn.query(
          "INSERT INTO task_adjudicators (task_id, user_id) VALUES (?, ?)",
          [tid, uid],
        );
      }
      if (newAdjUids.length) {
        await conn.query(
          `DELETE FROM task_assignees WHERE task_id = ? AND user_id IN (${newAdjUids
            .map(() => "?")
            .join(",")})`,
          [tid, ...newAdjUids],
        );
      }

      await recalcAnnotationSubmitted(conn, tid);
      await conn.query("UPDATE tasks SET adjudicated = 0 WHERE id = ?", [tid]);
    }
    await conn.commit();
    ok(res, { updated: taskIds.length });
  } catch (e) {
    await conn.rollback();
    fail(res, "批量分配失败：" + e.message);
  } finally {
    conn.release();
  }
});

module.exports = router;
