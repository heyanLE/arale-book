# LLM Harness 结构化返回协议

核对日期：2026-10-02。本文描述 Anki F1–F3、旧 R1–R3 和新 A2–A4 的 Chat Completions 返回协议；A0/A1/R0 不调用 LLM。旧 schema 由 `harness-tool.ts` 定义，新 `submit_anki_pipeline` / `verify_anki_pipeline` schema 与严格字段、问题类型和证据 ID 校验由 `core/study/pipeline.ts` 定义；未通过的批次不会被当成完成结果。

新 A 档位复用以下供应商协议协商。生成请求带输出 token 上限：OpenAI 官方地址用 `max_completion_tokens`，其他端点用 `max_tokens`。预算模式在每次 HTTP/协议重试前检查保守估算；返回 usage 时用供应商数字记账，未报告时用估算。`budgetTokens` 是实际/估算合并的预算记账，不能显示成已确认计费 token；正常输入/输出 token 与估算分开展示。单次实际用量仍可能超过估算；真实供应商和推理模型兼容性尚未验收。A 阶段预算不包含用户单独启动的 F 筛词，详情见 [Anki Harness](anki-harness.md)。

## 默认选择与降级

| 端点 | 第一次使用的协议 | 不兼容时 |
|---|---|---|
| `api.deepseek.com` | `response_format: {type: "json_object"}`；不覆盖 DeepSeek 的 thinking 默认值 | 提示词 JSON |
| `api.openai.com` | 严格 `json_schema` | 指定提交工具 → `json_object` → 提示词 JSON |
| 其他 Chat Completions 兼容端点 | 原有指定提交工具 | `json_object` → 提示词 JSON |

工具只是模型提交结果的参数容器，不执行外部副作用，也不额外发一次模型回执。`json_object` 保证 JSON 语法，不保证词条 ID 或业务字段正确。DeepSeek 标准地址的严格工具模式需要 `/beta`，而默认 thinking 的 Chat Completions 不接受强制指定工具名，因此默认直接使用其正式可用的 JSON Output。[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[工具模式](https://api-docs.deepseek.com/guides/tool_calls/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)；OpenAI 的 `json_schema` 见[官方结构化输出文档](https://developers.openai.com/api/docs/guides/structured-outputs)。

只有格式参数被端点明确拒绝（HTTP 400/422/501 且错误指出对应参数）才降级；401/403、429、超时和网络错误原样报错。工具请求被忽略但返回正文时，本次仍交给 Harness 校验，下次尝试 JSON Output。JSON 模式偶发空内容或非法 JSON 最多在同模式重试一次，仍不合格则由 Harness 缩小批次或停止。模型以 `finish_reason=length` 截断时按输出 token 限制处理，不保存残缺结果。

可用模式保存在 `<userData>/llm-output-capabilities.json`：键是配置 ID、地址、模型和结果 schema 的 SHA-256 指纹，只保存模式与校验时间，不保存 API key、提示词或回答。有效期 7 天；修改 LLM 配置后清除记录。后台任务入队与运行时比对 LLM 配置签名，防止排队/运行中更换模型或 Key 后混写结果。第一次不兼容时会逐级协商，成功模式供后续批次和重开应用复用。

## 用量口径

每书 `study-list.json` 分开记录逻辑 Harness 调用数、**实际 HTTP 尝试数**、协议回退次数、输入/输出 token，以及服务端报告的缓存命中/未命中 token。空 JSON 的重试若返回用量，也计入总 token。界面仅在服务端提供缓存数字时计算 `命中 ÷（命中＋未命中）`；旧记录和不报告这些字段的服务显示“缓存用量未返回”，不会把未知当作 0。原始提示词、响应和密钥不作为诊断日志保存。

## 验证与边界

2026-09-29，macOS / Node 22：`npm run typecheck`、`npm run build` 通过；`npm test` 476 项中 471 通过、5 跳过；`npm run smoke` 210/210。假端点覆盖 DeepSeek JSON Output 保留默认 thinking、OpenAI 严格 schema、工具/JSON 不兼容的逐级回退、鉴权错误不回退、空 JSON 有界重试、能力跨服务实例读取、配置变化拦截、HTTP/缓存 token 累计和真实 Electron IPC 落盘。**没有使用真实 DeepSeek/OpenAI Key 联网试跑**；供应商对 JSON 模式的实际质量、缓存命中与计费需在用户环境观察，Windows 目标系统未验收。
