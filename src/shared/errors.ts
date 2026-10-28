/**
 * 对外的错误只有这一组。响应体是 `{"error":"..."}`，绝不带内部堆栈或平台原始报文。
 */

export class AgentError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string, internal?: string) {
    super(internal ?? publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export const badRequest = (message = "请求无效") => new AgentError(400, message);
export const unauthorized = (message = "未授权") => new AgentError(401, message);
export const forbidden = (message = "禁止访问") => new AgentError(403, message);
export const notFound = (message = "不存在") => new AgentError(404, message);
export const conflict = (message = "状态已变化") => new AgentError(409, message);
export const tooMany = (message = "请求过于频繁") => new AgentError(429, message);
export const unavailable = (message = "平台暂时不可用") => new AgentError(503, message);
