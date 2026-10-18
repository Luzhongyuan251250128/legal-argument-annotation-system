require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { fail } = require("./utils/response");
const { authRequired } = require("./middleware/auth");

const authRouter = require("./routes/auth");
const usersRouter = require("./routes/users");
const labelsRouter = require("./routes/labels");
const tasksRouter = require("./routes/tasks");
const annotationsRouter = require("./routes/annotations");
const adjudicationsRouter = require("./routes/adjudications");
const documentsRouter = require("./routes/documents");
const exportsRouter = require("./routes/exports");
const teachingRouter = require("./routes/teaching");
const adminRouter = require("./routes/admin");

const app = express();

// 部署在 nginx / 负载均衡后面时，正确识别 https 协议与客户端 IP
// 影响 req.protocol（导出时拼下载地址）与 req.ip（审计日志）
app.set("trust proxy", 1);

// 基础中间件
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// 静态资源：导出的文件
app.use("/exports", express.static(path.join(__dirname, "exports")));

// 健康检查
app.get("/health", (req, res) =>
  res.json({ code: 0, message: "ok", data: { ts: Date.now() } }),
);

// 前端静态页面：访问 / 直接打开 index.html
app.use("/", express.static(path.join(__dirname, "..", "frontend")));

// 认证相关（无需登录的部分由路由内部处理）
app.use("/auth", authRouter);

// 以下路由全部要求登录
app.use("/users", authRequired, usersRouter);
app.use("/labels", authRequired, labelsRouter);
app.use("/tasks", authRequired, tasksRouter);

// 任务下的子资源：annotations / review / adjudicate
// 注意：tasksRouter 已经挂在 /tasks；为避免路径冲突，这里把 annotations 与 adjudications 的路径直接并入
app.use("/tasks", authRequired, annotationsRouter);
app.use("/tasks", authRequired, adjudicationsRouter);
app.use("/admin", authRequired, adminRouter);

// 我的任务需要单独挂载到 /my-tasks
app.get("/my-tasks", authRequired, (req, res, next) => {
  req.url = "/my";
  tasksRouter.handle(req, res, next);
});

app.use("/documents", authRequired, documentsRouter);
app.use("/exports", authRequired, exportsRouter); // 注意：POST /exports 与静态 GET 不冲突
app.use("/teaching", authRequired, teachingRouter);

// 404
app.use((req, res) =>
  fail(res, "接口不存在: " + req.method + " " + req.originalUrl, 404, 404),
);

// 全局错误
app.use((err, req, res, next) => {
  console.error("[error]", err);
  fail(res, err.message || "服务器内部错误", 500, 500);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log("论证标注工作台后端已启动: http://localhost:" + PORT);
});
