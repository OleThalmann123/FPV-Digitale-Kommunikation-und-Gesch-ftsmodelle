export async function extractFromImages(
    base64Images: string[],
    apiKey: string,
    fragebogen?: string
): Promise<string> {
    if (!apiKey) throw new Error("API Key required for OpenRouter");

    const contentArray: any[] = [
        {
            type: "text",
            text: `Bitte extrahiere die demografischen Profil-Variablen aus diesen Screenshots (falls vorhanden): Rolle, Geschlecht, Alter, Nationalitaet, Haushalt, Ausbildung, Berufserfahrung, Wohnsitzland, Postleitzahl, Avatar_Eigenschaften_und_Praeferenzen. 
Zudem extrahiere alle relevanten Umfrage-Antworten (dies können Text-Antworten, Zahlen, Likert-Skalen 1-7, etc. sein). 

WICHTIG: Auf den Screenshots sind die Fragen eventuell nicht direkt ersichtlich. Bitte werte die erkennbaren Antworten (z.B. Radiobuttons, Dropdowns, Checkboxen, offene Textfelder, Slider auf Skala 1-7) in der Reihenfolge ihres Auftretens aus. 
Falls ein Fragebogen als Kontext mitgeliefert wird, nutze diesen zwingend, um die Antworten den korrekten Fragen (z.B. F1, F2, F3 etc.) zuzuordnen. Nutze EXAKT die Bezeichnungen (F1, F2...) aus dem Fragebogen.
${fragebogen ? `\nHIER IST DER FRAGEBOGEN ALS KONTEXT:\n---\n${fragebogen}\n---\n\nOrdne die Antworten chronologisch den Fragen in diesem Fragebogen zu (F1, F2, ...).` : ''}

Gib AUSSCHLIESSLICH ein valides JSON zurück in folgendem Format (ohne Markdown Code Blocks):
{
  "profil": {
    "Rolle": "Extrahierter Wert oder leer",
    "Geschlecht": "Extrahierter Wert oder leer",
    "Alter": "Extrahierter Wert oder leer",
    "Nationalitaet": "Extrahierter Wert oder leer",
    "Haushalt": "Extrahierter Wert oder leer",
    "Ausbildung": "Extrahierter Wert oder leer",
    "Berufserfahrung": "Extrahierter Wert oder leer",
    "Wohnsitzland": "Extrahierter Wert oder leer",
    "Postleitzahl": "Extrahierter Wert oder leer",
    "Avatar_Eigenschaften_und_Praeferenzen": "Weiteres wie z.b. Beruf etc."
  },
  "antworten": {
    "F1": "Beispiel Antwort Text",
    "F2": "Technologie & Software",
    "F3": 5,
    "F4": "Hybrid"
  }
}`
        },
        ...base64Images.map(imgBase64 => ({
            type: "image_url",
            image_url: {
                url: imgBase64,
                // High detail: jeder Mobile-Screenshot wird in 512x512-Tiles zerlegt
                // (~1.4k Tokens/Bild), damit feiner Text gut lesbar bleibt. Token-
                // Volumen wird via Sub-Chunking in runDemoscopeExtraction kontrolliert.
                detail: "high"
            }
        }))
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'Meta Prompt Platform',
        },
        body: JSON.stringify({
            model: 'openai/gpt-4o', // Must use a vision model
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
