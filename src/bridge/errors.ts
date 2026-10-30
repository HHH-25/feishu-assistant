export class BridgeError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function safeError(error: unknown) {
  return error instanceof BridgeError ? { code: error.code, message: error.message } :
    { code: 'UPSTREAM_OR_INTERNAL', message: '请求未完成；写入结果请通过操作状态核实，勿重复提交。' };
}
