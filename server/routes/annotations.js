const express = require("express");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// 取得或创建当前用户对该任务的标注版本
async function getOrCreateVersion(conn, taskId, annotatorId) {
  const [rows] = await conn.query(
    'SELECT * FROM annotation_versions WHERE task_id = ? AND annotator_id = ? AND status != "rejected" ORDER BY version_no DESC LIMIT 1',
    [taskId, annotatorId],
  );
  if (rows[0]) return rows[0];
  const [r] = await conn.query(
    'INSERT INTO annotation_versions (task_id, annotator_id, version_no, status) VALUES (?, ?, 1, "draft")',
    [taskId, annotatorId],
  );
  return {
    id: r.insertId,
    task_id: taskId,
    annotator_id: annotatorId,
    version_no: 1,
    status: "draft",
  };
}

// 拉取标注内容
router.get("/:id/annotations", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const uid = req.user.id;
  try {
    const [taskRows] = await pool.query(
      "SELECT source_text FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    const [verRows] = await pool.query(
      "SELECT * FROM annotation_versions WHERE task_id = ? AND annotator_id = ? ORDER BY version_no DESC LIMIT 1",
      [taskId, uid],
    );
    let propositions = [],
      relations = [];
    if (verRows[0]) {
      const versionId = verRows[0].id;
      const [pRows] = await pool.query(
        "SELECT prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order FROM propositions WHERE annotation_version_id = ? ORDER BY sort_order",
        [versionId],
      );
      const [rRows] = await pool.query(
        "SELECT rel_code, type, endpoints, expression FROM relations WHERE annotation_version_id = ?",
        [versionId],
      );
      propositions = pRows.map((p) => ({
        id: Number(String(p.prop_code).replace(/^p/, "")) || p.prop_code,
        propCode: p.prop_code,
        text: p.text,
        label: p.secondary_label || "",
        primaryLabel: p.primary_label || "",
        start: p.start_index,
        end: p.end_index,
        x: Number(p.pos_x) || 50,
        y: Number(p.pos_y) || 50,
      }));
      relations = rRows.map((r) => {
        const eps =
          typeof r.endpoints === "string"
            ? JSON.parse(r.endpoints)
            : r.endpoints || [];
        const rel = {
          id: Number(String(r.rel_code).replace(/^R/, "")) || r.rel_code,
          relCode: r.rel_code,
          type: r.type,
          expression: r.expression,
        };
        // 单/多端点区分
        if (Array.isArray(eps) && eps.length > 2) rel.endpoints = eps;
        else if (Array.isArray(eps) && eps.length === 2) {
          rel.from = eps[0];
          rel.to = eps[1];
        }
        return rel;
      });
    }
    ok(res, {
      taskId,
      sourceText: taskRows[0] ? taskRows[0].source_text : "",
      propositions,
      relations,
      submitted: verRows[0]
        ? verRows[0].status === "submitted" || verRows[0].status === "final"
        : false,
    });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 保存标注（草稿态）
router.put("/:id/annotations", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const uid = req.user.id;
  const { propositions = [], relations = [] } = req.body || {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 已进入裁定阶段或已裁定：禁止修改
    const [taskRows] = await conn.query(
      "SELECT annotation_submitted, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    if (
      taskRows[0] &&
      (taskRows[0].annotation_submitted === 1 || taskRows[0].adjudicated === 1)
    ) {
      await conn.rollback();
      return fail(res, "任务已进入裁定阶段，不可修改标注");
    }
    const version = await getOrCreateVersion(conn, taskId, uid);
    const versionId = version.id;

    await conn.query(
      "DELETE FROM propositions WHERE annotation_version_id = ?",
      [versionId],
    );
    await conn.query("DELETE FROM relations WHERE annotation_version_id = ?", [
      versionId,
    ]);

    for (let i = 0; i < propositions.length; i++) {
      const p = propositions[i];
      await conn.query(
        `INSERT INTO propositions
          (annotation_version_id, prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          p.id || "p" + (i + 1),
          p.text,
          p.primaryLabel || null,
          p.label || null,
          p.start != null ? p.start : null,
          p.end != null ? p.end : null,
          p.x != null ? p.x : 50,
          p.y != null ? p.y : 50,
          i,
        ],
      );
    }
    for (let i = 0; i < relations.length; i++) {
      const r = relations[i];
      const eps =
        r.endpoints && r.endpoints.length
          ? r.endpoints
          : [r.from, r.to].filter((v) => v != null);
      await conn.query(
        "INSERT INTO relations (annotation_version_id, rel_code, type, endpoints, expression) VALUES (?, ?, ?, ?, ?)",
        [
          versionId,
          r.id || "R" + (i + 1),
          r.type,
          JSON.stringify(eps),
          r.expression || null,
        ],
      );
    }
    await conn.commit();
    ok(res, { ok: true, versionId });
  } catch (e) {
    await conn.rollback();
    fail(res, "保存失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 提交标注
router.post("/:id/annotations/submit", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const uid = req.user.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 已进入裁定阶段或已裁定：禁止再次提交
    const [taskRows] = await conn.query(
      "SELECT annotation_submitted, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    if (
      taskRows[0] &&
      (taskRows[0].annotation_submitted === 1 || taskRows[0].adjudicated === 1)
    ) {
      await conn.rollback();
      return fail(res, "任务已进入裁定阶段，不可重复提交");
    }
    const [rows] = await conn.query(
      "SELECT id FROM annotation_versions WHERE task_id = ? AND annotator_id = ? ORDER BY version_no DESC LIMIT 1",
      [taskId, uid],
    );
    if (!rows[0]) {
      await conn.rollback();
      return fail(res, "尚未保存标注");
    }
    const versionId = rows[0].id;
    // 兜底校验：该版本中所有命题的一级、二级标签都必须有值
    const [pRows] = await conn.query(
      "SELECT prop_code, text, primary_label, secondary_label FROM propositions WHERE annotation_version_id = ?",
      [versionId],
    );
    if (!pRows.length) {
      await conn.rollback();
      return fail(res, "请先标注至少一个命题");
    }
    const incomplete = pRows.filter(
      (p) => !p.primary_label || !p.secondary_label,
    );
    if (incomplete.length) {
      await conn.rollback();
      const first = incomplete[0];
      return fail(
        res,
        "存在 " +
          incomplete.length +
          " 个命题未选择标签（首个为 " +
          first.prop_code +
          "：" +
          (first.text || "") +
          "），请补全后再提交",
      );
    }
    await conn.query(
      'UPDATE annotation_versions SET status = "submitted", submitted_at = NOW() WHERE id = ?',
      [versionId],
    );
    // 仅当所有被分配标注者都已提交时，才进入裁定阶段
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
    if (allSubmitted) {
      await conn.query(
        "UPDATE tasks SET annotation_submitted = 1 WHERE id = ?",
        [taskId],
      );
    }
    await conn.commit();
    ok(res, { ok: true, allSubmitted, total, submitted });
  } catch (e) {
    await conn.rollback();
    fail(res, "提交失败：" + e.message);
  } finally {
    conn.release();
  }
});

// 拉取最终裁定版本（供结果页只读展示）
router.get("/:id/final", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  try {
    const [taskRows] = await pool.query(
      "SELECT source_text, final_annotation_version_id, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    const task = taskRows[0];
    if (!task) return fail(res, "任务不存在");
    if (!task.adjudicated) return fail(res, "任务尚未完成裁定");
    if (!task.final_annotation_version_id)
      return fail(res, "该任务尚未生成最终版本");

    const versionId = task.final_annotation_version_id;
    const [pRows] = await pool.query(
      "SELECT prop_code, text, primary_label, secondary_label, start_index, end_index, pos_x, pos_y, sort_order FROM propositions WHERE annotation_version_id = ? ORDER BY sort_order",
      [versionId],
    );
    const [rRows] = await pool.query(
      "SELECT rel_code, type, endpoints, expression FROM relations WHERE annotation_version_id = ?",
      [versionId],
    );

    const propositions = pRows.map((p) => ({
      id: Number(String(p.prop_code).replace(/^p/, "")) || p.prop_code,
      propCode: p.prop_code,
      text: p.text,
      label: p.secondary_label || "",
      primaryLabel: p.primary_label || "",
      start: p.start_index,
      end: p.end_index,
      x: Number(p.pos_x) || 50,
      y: Number(p.pos_y) || 50,
    }));
    const relations = rRows.map((r) => {
      const eps =
        typeof r.endpoints === "string"
          ? JSON.parse(r.endpoints)
          : r.endpoints || [];
      const rel = {
        id: Number(String(r.rel_code).replace(/^R/, "")) || r.rel_code,
        relCode: r.rel_code,
        type: r.type,
        expression: r.expression,
      };
      if (Array.isArray(eps) && eps.length > 2) rel.endpoints = eps;
      else if (Array.isArray(eps) && eps.length === 2) {
        rel.from = eps[0];
        rel.to = eps[1];
      }
      return rel;
    });

    ok(res, {
      taskId,
      finalVersionId: versionId,
      sourceText: task.source_text || "",
      propositions,
      relations,
    });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

// 拉取比对数据（供裁定页使用）
router.get("/:id/review", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  try {
    const [taskRows] = await pool.query(
      "SELECT source_text, reason_text, reason_start, reason_end, annotation_submitted, adjudicated FROM tasks WHERE id = ? LIMIT 1",
      [taskId],
    );
    if (!taskRows[0]) return fail(res, "任务不存在");
    if (
      taskRows[0].annotation_submitted !== 1 &&
      taskRows[0].adjudicated !== 1
    ) {
      return fail(res, "任务尚未进入裁定阶段，需等待所有标注者提交标注");
    }
    const [verRows] = await pool.query(
      `SELECT av.id, av.annotator_id, av.status, av.submitted_at, u.display_name
       FROM annotation_versions av
       JOIN users u ON u.id = av.annotator_id
       WHERE av.task_id = ? AND av.status IN ('submitted','final')`,
      [taskId],
    );
    const versions = [];
    for (const v of verRows) {
      const [pRows] = await pool.query(
        "SELECT prop_code, text, primary_label, secondary_label, start_index, end_index FROM propositions WHERE annotation_version_id = ? ORDER BY sort_order",
        [v.id],
      );
      const [rRows] = await pool.query(
        "SELECT rel_code, type, endpoints, expression FROM relations WHERE annotation_version_id = ?",
        [v.id],
      );
      versions.push({
        versionId: v.id,
        annotatorId: v.annotator_id,
        annotatorName: v.display_name,
        status: v.status,
        submittedAt: v.submitted_at,
        propositions: pRows.map((p) => ({
          code: p.prop_code,
          text: p.text,
          primaryLabel: p.primary_label,
          label: p.secondary_label,
          start: p.start_index,
          end: p.end_index,
        })),
        relations: rRows.map((r) => {
          const eps =
            typeof r.endpoints === "string"
              ? JSON.parse(r.endpoints)
              : r.endpoints || [];
          return {
            code: r.rel_code,
            type: r.type,
            endpoints: eps,
            expression: r.expression,
          };
        }),
      });
    }
    // 双人切割比对（简化：按位置分组）
    const cutComparison = {
      annotatorA: versions[0]
        ? {
            name: versions[0].annotatorName,
            segments: versions[0].propositions.map((p) => ({
              text: p.text,
              diff: false,
            })),
          }
        : { name: "—", segments: [] },
      annotatorB: versions[1]
        ? {
            name: versions[1].annotatorName,
            segments: versions[1].propositions.map((p) => ({
              text: p.text,
              diff: false,
            })),
          }
        : { name: "—", segments: [] },
      diffRatio: 0,
      threshold: 10,
      totalPoints: 0,
      agreedPoints: 0,
    };
    ok(res, {
      taskId,
      sourceText: taskRows[0] ? taskRows[0].source_text : "",
      reasonText: taskRows[0] ? taskRows[0].reason_text : "",
      reasonStart: taskRows[0] ? taskRows[0].reason_start : null,
      reasonEnd: taskRows[0] ? taskRows[0].reason_end : null,
      versions,
      cutComparison,
    });
  } catch (e) {
    fail(res, "查询失败：" + e.message);
  }
});

module.exports = router;
