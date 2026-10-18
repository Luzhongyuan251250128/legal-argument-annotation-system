const express = require("express");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");
const { buildFinalVersion } = require("../utils/finalVersion");

const router = express.Router();

// 保存裁定结果
router.post("/:id/adjudicate", authRequired, async (req, res) => {
  const taskId = Number(req.params.id);
  const uid = req.user.id;
  const raw = (req.body && req.body.decisions) || [];
  const finalAnnotations = req.body && req.body.finalAnnotations;
  if (!Array.isArray(raw)) return fail(res, "裁定数据格式错误");

  // 新增：校验重标数据
  const needsRelabel = raw.some(
    (d) => d.mode === "relabel" || d.mode === "expert",
  );
  let validFinalAnnotations = null;

  if (needsRelabel) {
    if (!finalAnnotations || !Array.isArray(finalAnnotations.propositions)) {
      return fail(res, "重标/专家裁决未完成，缺少标注数据");
    }
    const incomplete = finalAnnotations.propositions.filter(
      (p) => !p.primaryLabel || !p.label,
    );
    if (incomplete.length > 0) {
      return fail(
        res,
        "重标结果中存在未选择标签的命题（" +
          incomplete.map((p) => p.propCode).join(", ") +
          "），请补全后再提交",
      );
    }
    // 存在重标，才认这个数据
    validFinalAnnotations = finalAnnotations;
  } else {
    // 如果没有任何重标，即使前端传了旧数据，也直接丢弃，按纯粹的版本采纳逻辑去合并
    validFinalAnnotations = null;
  }

  const decisions = [];
  for (const d of raw) {
    if (!d || !d.key || !d.mode) return fail(res, "裁定数据不完整");
    const mode = String(d.mode);
    if (!["version", "reject", "relabel", "expert"].includes(mode)) {
      return fail(res, "不支持的裁定方式：" + mode);
    }
    if (mode === "version") {
      const vi = Number(d.versionIndex);
      if (!Number.isInteger(vi) || vi < 0)
        return fail(res, "存在未选择标注版本的裁定项");
      decisions.push({
        key: String(d.key),
        kind: d.kind || "",
        title: d.title || "",
        text: d.text || "",
        mode,
        versionIndex: vi,
        annotatorName: d.annotatorName || null,
        value: null,
      });
    } else if (mode === "relabel" || mode === "expert") {
      if (!finalAnnotations || !Array.isArray(finalAnnotations.propositions)) {
        return fail(
          res,
          mode === "expert" ? "专家裁决未完成重标" : "裁定者重标未完成",
        );
      }
      decisions.push({
        key: String(d.key),
        kind: d.kind || "",
        title: d.title || "",
        text: d.text || "",
        mode,
        versionIndex: null,
        annotatorName: null,
        value: null,
      });
    } else {
      decisions.push({
        key: String(d.key),
        kind: d.kind || "",
        title: d.title || "",
        text: d.text || "",
        mode,
        versionIndex: null,
        annotatorName: null,
        value: null,
      });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const payload = { decisions, savedAt: new Date().toISOString() };
    await conn.query(
      `INSERT INTO adjudications
        (task_id, adjudicator_id, label_decision, relation_decision, decisions_json)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        label_decision = VALUES(label_decision),
        relation_decision = VALUES(relation_decision),
        decisions_json = VALUES(decisions_json),
        decided_at = CURRENT_TIMESTAMP`,
      [taskId, uid, null, null, JSON.stringify(payload)],
    );
    // 按逐项决策重建最终标注版本
    const finalVersionId = await buildFinalVersion(
      conn,
      taskId,
      decisions,
      uid,
      validFinalAnnotations,
    );
    if (!finalVersionId) {
      await conn.rollback();
      return fail(res, "没有可用的标注版本，无法生成最终版");
    }
    await conn.query(
      "UPDATE tasks SET adjudicated = 1, final_annotation_version_id = ? WHERE id = ?",
      [finalVersionId, taskId],
    );
    await conn.commit();
    ok(res, {
      ok: true,
      decisionCount: decisions.length,
      finalVersionId,
      adjudicatedAt: new Date().toISOString(),
    });
  } catch (e) {
    await conn.rollback();
    fail(res, "保存失败：" + e.message);
  } finally {
    conn.release();
  }
});

module.exports = router;
