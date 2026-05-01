// Geteilte Types fuer Client- und Server-Code. Bewusst KEINE 'use server' /
// 'use client'-Direktive, damit beide Seiten importieren koennen, ohne die
// Next.js-Boundary-Regeln zu verletzen ('use server'-Dateien duerfen nur
// async functions exportieren).

export type ModelConfig = {
    type: 'openrouter' | 'local' | 'publicai';
    modelId: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
};
