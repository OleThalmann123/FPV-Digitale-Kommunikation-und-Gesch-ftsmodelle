'use server';

import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ModelConfig } from './types';
import { buildVisionPrompt } from '@/lib/visionPrompt';

const execPromise = util.promisify(exec);

// Server-seitige Defaults: Keys werden NIE in den Client geleakt. Client-seitig
// uebergebene Override-Keys (apiKey-Parameter) gewinnen, sonst zieht der Server
// den Key aus den env vars. Lokal in `.env.local`, in Produktion in Vercel
// "Environment Variables" konfigurieren. Beide Schreibweisen (OPENROUTER_API_KEY
// und OPEN_ROUTER_API_KEY) werden akzeptiert -- OpenRouter selbst schreibt sich
// als ein Wort, in der Vercel-Console wurde aber teilweise mit Underscore
// angelegt.
const getOpenRouterKey = (override?: string) =>
    override
    || process.env.OPENROUTER_API_KEY
    || process.env.OPEN_ROUTER_API_KEY
    || '';
const getPublicAiKey = () =>
    process.env.PUBLICAI_API_KEY
    || process.env.PUBLIC_AI_API_KEY
    || '';

export async function processPrompt(
    prompt: string,
    modelConfig: ModelConfig,
    apiKey?: string
): Promise<string> {
    const commonPayload: any = {
        model: modelConfig.modelId,
        messages: [{ role: 'user', content: prompt }],
    };
    if (modelConfig.temperature !== undefined) commonPayload.temperature = modelConfig.temperature;
    if (modelConfig.top_p !== undefined) commonPayload.top_p = modelConfig.top_p;
    if (modelConfig.max_tokens !== undefined) commonPayload.max_tokens = modelConfig.max_tokens;

    if (modelConfig.type === 'openrouter') {
        const effectiveKey = getOpenRouterKey(apiKey);
        if (!effectiveKey) throw new Error("Kein OpenRouter-API-Key gesetzt. Bitte OPENROUTER_API_KEY als env var konfigurieren oder in den Settings eintragen.");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${effectiveKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'Meta Prompt Platform',
            },
            body: JSON.stringify({
                ...commonPayload,
                model: modelConfig.modelId || 'openrouter/auto',
            }),
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} ${errorBody}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || 'No response';
    } else if (modelConfig.type === 'publicai') {
        const publicAiKey = getPublicAiKey();
        if (!publicAiKey) throw new Error("Kein PublicAI-API-Key gesetzt. Bitte PUBLICAI_API_KEY als env var konfigurieren.");
        let response;
        let attempts = 0;
        const maxAttempts = 2;
        let lastError = null;

        while (attempts < maxAttempts) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 second timeout

                response = await fetch('https://api.publicai.co/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${publicAiKey}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Prompt-Platform'
                    },
                    body: JSON.stringify({
                        ...commonPayload,
                        model: modelConfig.modelId || 'swiss-ai/apertus-70b-instruct',
                    }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) break;

                // If it's a 504 Gateway Timeout or 429 Rate Limit, we shouldn't fail immediately
                if (response.status === 504 || response.status === 502 || response.status === 429) {
                    attempts++;
                    if (attempts < maxAttempts) {
                        // Backoff: 2s, 4s...
                        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
                        continue;
                    }
                }

                // For other errors or max attempts reached, we break and let it throw below
                break;
            } catch (err: any) {
                lastError = err;
                attempts++;
                if (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
                    continue;
                } else {
                    break;
                }
            }
        }

        if (!response || !response.ok) {
            let errorBody = 'Unknown Error';
            try {
                if (response) errorBody = await response.text();
            } catch (e) { }
            throw new Error(`PublicAI API error nach ${attempts} Versuchen: ${response?.status || lastError?.message || 'Network Timeout'} ${errorBody}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || 'No response';
    } else if (modelConfig.type === 'local') {
        // Generate command for MLX
        const tmpDir = os.tmpdir();
        const promptFilePath = path.join(tmpDir, `prompt_${Date.now()}.txt`);

        // Write prompt to temp file to avoid CLI escaping issues
        await fs.writeFile(promptFilePath, prompt, 'utf-8');

        try {
            // Execute the python script with our local environment, disabling heavy progress bars
            const scriptPath = path.join(process.cwd(), 'run_mlx.py');
            const { stdout, stderr } = await execPromise(
                `HF_HUB_DISABLE_PROGRESS_BARS=1 source apertus-env/bin/activate && python3 "${scriptPath}" "${modelConfig.modelId}" "${promptFilePath}"`,
                {
                    cwd: process.cwd(),
                    maxBuffer: 1024 * 1024 * 50 // 50MB to avoid breaking on huge download logs
                }
            );

            return stdout.trim();
        } catch (err: any) {
            throw new Error(`Local MLX error: ${err.message || ''} \n${err.stderr || ''}`);
        } finally {
            // Clean up the temp file
            await fs.unlink(promptFilePath).catch(() => { });
        }
    }

    throw new Error("Invalid model config type.");
}



export async function fetchOpenRouterModels(apiKey?: string) {
    const effectiveKey = getOpenRouterKey(apiKey);
    if (!effectiveKey) return [];
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'Authorization': `Bearer ${effectiveKey}`,
            }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.data || [];
    } catch {
        return [];
    }
}

export async function fetchPublicAIModels() {
    try {
        const publicAiKey = getPublicAiKey();
        if (!publicAiKey) return [];
        const response = await fetch('https://api.publicai.co/v1/models', {
            headers: {
                'Authorization': `Bearer ${publicAiKey}`,
            }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.data || [];
    } catch {
        return [];
    }
}

// Demoscope Vision-Extraktion: laeuft jetzt server-seitig, damit der OpenRouter-
// Key nie im Client-Bundle landet. Sub-Chunking (10 Bilder pro Call) bleibt im
// Client (page.tsx), damit der Fortschritt pro Sub-Batch sichtbar bleibt und
// jeder Server-Call deutlich unter dem 50mb-bodySizeLimit aus next.config.ts
// liegt.
export async function extractFromImages(
    base64Images: string[],
    apiKey?: string,
    fragebogen?: string
): Promise<string> {
    const effectiveKey = getOpenRouterKey(apiKey);
    if (!effectiveKey) throw new Error("Kein OpenRouter-API-Key gesetzt. Bitte OPENROUTER_API_KEY als env var konfigurieren oder in den Settings eintragen.");

    const contentArray: any[] = [
        {
            type: "text",
            text: buildVisionPrompt(fragebogen)
        },
        ...base64Images.map(imgBase64 => ({
            type: "image_url",
            image_url: {
                url: imgBase64,
                detail: "high"
            }
        }))
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${effectiveKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'Meta Prompt Platform',
        },
        body: JSON.stringify({
            model: 'openai/gpt-4o',
            messages: [{ role: 'user', content: contentArray }],
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${errorBody}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '{}';
}

