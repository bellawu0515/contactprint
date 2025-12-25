import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(
  _req: VercelRequest,
  res: VercelResponse
) {
  res.status(200).json({
    ok: true,
    service: "contactprint",
    env: process.env.VERCEL_ENV || "production",
    time: new Date().toISOString()
  });
}
