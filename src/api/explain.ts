import express from "express";
import type { Request, Response } from "express";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export const explainRouter = express.Router();

type Query = {
    diff: string;
}

explainRouter.post(
    "/explain",
    async (req: Request<{}, {}, Query, {}>, res: Response) => {
        // SSE headers
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const send = (event: string, data: any) => {
            // if (closed) return;
            res.write(`event: ${event}\n`);
            res.write(
                `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
            );
        };

        try {
            const stream = await openai.responses.create({
                model: MODEL,
                stream: true,
                prompt: {
                    id: "pmpt_696bf772c9608195b5ab8254bc9d23810d1f3023be857700",
                    variables: {
                        diff: req.body.diff,
                    },
                },
            });

            for await (const event of stream as any) {
                // if (closed) break;

                if (event.type === "response.output_text.delta") {
                    const delta: string = event.delta ?? "";
                    if (!delta) continue;

                    send("delta", delta);
                    continue;
                }

                if (event.type === "response.output_text.done") {
                    // TODO
                }

                if (event.type === "response.completed") {
                    // TODO
                }

                if (event.type === "response.failed" || event.type === "response.incomplete") {
                    send("error", { type: event.type });
                    break;
                }
            }
        } catch (e) {
            console.error("OpenAI streaming error", e);
            send("error", { message: "OpenAI streaming error" });
        } finally {
            res.end();
        }
    }
);
