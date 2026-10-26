import express from 'express';

/** This is a transport bound for an authenticated local request, not a per-image
 * rejection. Base64 adds roughly one third to the original attachment sizes. */
export function questionJsonBody(limitMb = Number(process.env.OCS_QUESTION_MAX_REQUEST_MB || 256)) {
	if (!Number.isFinite(limitMb) || limitMb <= 0) throw new Error('OCS_QUESTION_MAX_REQUEST_MB 必须为正数');
	return express.json({ limit: Math.floor(limitMb * 1024 * 1024) });
}

export const questionBodyError: express.ErrorRequestHandler = (error, _req, res, next) => {
	if (error?.type === 'entity.too.large') {
		res
			.status(413)
			.json({ error: '题目请求超过本地传输容量；可通过 OCS_QUESTION_MAX_REQUEST_MB 调整（默认 256 MiB）。' });
	} else if (error?.type === 'entity.parse.failed') {
		res.status(400).json({ error: '题目请求包含无效的 JSON 数据' });
	} else next(error);
};
