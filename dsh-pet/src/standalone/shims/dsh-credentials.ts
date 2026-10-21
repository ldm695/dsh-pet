/**
 * `@deepseek-ai/dsh-credentials` 的独立模式替身。
 *
 * 插件用 `credentialRef()` 构造交给 `ctx.credentials.resolve()` 的引用（DeepSeek 余额查询）。
 * 独立模式 context 只解析 DEEPSEEK_API_KEY：优先使用 DeepSeek 官方协议下的独立 AI 密钥，
 * 再回退到应用专用环境变量；不会读取或暴露其他凭据。
 *
 * 只在独立模式构建里生效：`tsdown.config.mjs` 用 alias 把该包名指向本文件。
 */

/** 引用原样返回；实际解析由独立 context 的凭据适配器负责 */
export function credentialRef(ref: unknown): unknown {
  return ref;
}
