const express = require("express");
const multer = require("multer");
// 直接引 lib 版本，绕过 pdf-parse 默认入口的调试代码
const { extractText, getDocumentProxy } = require("unpdf");
const mammoth = require("mammoth");
const pool = require("../db");
const { ok, fail } = require("../utils/response");
const { authRequired } = require("../middleware/auth");
const { extractReason } = require("../utils/extract");

const router = express.Router();

// 内存存储，20MB 上限
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// 单文件解析：接收 PDF / Word / TXT，返回纯文本
router.post("/parse", authRequired, upload.single("file"), async (req, res) => {
  if (!req.file) return fail(res, "缺少上传文件");
  const name = (req.file.originalname || "").toLowerCase();
  const buffer = req.file.buffer;
  try {
    let text = "";
    if (name.endsWith(".txt")) {
      text = buffer.toString("utf8");
    } else if (name.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const result = await extractText(pdf, { mergePages: true });
      text = result.text || "";
    } else if (name.endsWith(".docx")) {
      const data = await mammoth.extractRawText({ buffer });
      text = data.value || "";
    } else if (name.endsWith(".doc")) {
      return fail(res, "旧版 .doc 格式暂不支持，请另存为 .docx 后重试");
    } else {
      return fail(res, "不支持的文件格式：" + name);
    }
    // 清理多余空行
    text = text
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return fail(res, "文件内容为空或无法解析");
    ok(res, { text, filename: req.file.originalname });
  } catch (e) {
    fail(res, "解析失败：" + e.message);
  }
});

// 智能提取裁判理由
router.post("/extract-reason", authRequired, async (req, res) => {
  const { text, strategy, caseType, taskId } = req.body || {};
  if (!text || typeof text !== "string") return fail(res, "缺少文书文本");
  try {
    const result = extractReason(
      text,
      strategy || "auto",
      caseType || "ordinary",
    );
    if (taskId && result.start !== result.end) {
      await pool.query(
        "UPDATE tasks SET reason_text = ?, reason_start = ?, reason_end = ? WHERE id = ?",
        [result.text, result.start, result.end, taskId],
      );
    }
    ok(res, result);
  } catch (e) {
    fail(res, "提取失败：" + e.message);
  }
});

module.exports = router;
