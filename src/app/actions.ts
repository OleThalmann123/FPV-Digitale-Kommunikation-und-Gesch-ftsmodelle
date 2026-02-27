'use server';

import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execPromise = util.promisify(exec);

export type ModelConfig = {
    type: 'openrouter' | 'local' | 'publicai';
    modelId: string;
};

export async function processPrompt(
    prompt: string,
    modelConfig: ModelConfig,
    apiKey?: string
): Promise<string> {
    if (modelConfig.type === 'openrouter') {
        if (!apiKey) throw new Error("API Key required for OpenRouter");
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'Meta Prompt Platform',
            },
            body: JSON.stringify({
                model: modelConfig.modelId || 'openrouter/auto',
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} ${errorBody}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || 'No response';
    } else if (modelConfig.type === 'publicai') {
        const publicAiKey = 'zpka_a401f6eba2f440e3a7807bf9dafe7d20_1d367ff1';
        let response;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            response = await fetch('https://api.publicai.co/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${publicAiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Prompt-Platform'
                },
                body: JSON.stringify({
                    model: modelConfig.modelId || 'swiss-ai/apertus-70b-instruct',
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

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
        }

        if (!response || !response.ok) {
            const errorBody = await response?.text().catch(() => 'No body');
            throw new Error(`PublicAI API error nach ${attempts} Versuchen: ${response?.status} ${errorBody}`);
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
