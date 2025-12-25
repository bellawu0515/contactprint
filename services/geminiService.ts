/**
 * Gemini 调用也必须走后端（避免在前端暴露 API Key）。
 */
export class GeminiService {
  static async generateSupplychainReport(prompt: string): Promise<string> {
    const res = await fetch('/api/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI backend error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as any;
    return String(data?.text ?? '');
  }
}
