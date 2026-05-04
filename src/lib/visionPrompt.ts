// Shared Vision-Prompt-Builder. Wird sowohl serverseitig (actions.ts) für den
// echten OpenRouter-Call benutzt, als auch clientseitig (page.tsx), damit der
// exakt gleiche Prompt-Text in Excel- und Supabase-Persistenz landet.
export function buildVisionPrompt(fragebogen?: string): string {
  return `Bitte extrahiere die demografischen Profil-Variablen aus diesen Screenshots (falls vorhanden): Rolle, Geschlecht, Alter, Nationalitaet, Haushalt, Ausbildung, Berufserfahrung, Wohnsitzland, Postleitzahl, Avatar_Eigenschaften_und_Praeferenzen.
Zudem extrahiere alle relevanten Umfrage-Antworten (dies können Text-Antworten, Zahlen, Likert-Skalen 1-7, etc. sein).

WICHTIG -- ÜBERLAPPENDE SCREENSHOTS:
Die Screenshots stammen aus einem gescrollten Chat-Verlauf. Aufeinanderfolgende Bilder überlappen sich vertikal (das untere Drittel von Bild N entspricht dem oberen Drittel von Bild N+1). Dieselbe Frage und dieselbe Antwort kann daher auf zwei aufeinanderfolgenden Bildern sichtbar sein.
- Behandle den gesamten Bilder-Stapel als EINEN durchgehenden Chat-Verlauf.
- Extrahiere jede Frage-Antwort-Kombination GENAU EINMAL, auch wenn sie auf mehreren Bildern erscheint.
- Jeder F-Schlüssel (F1, F2, ...) und jeder Q-Schlüssel darf im Output-JSON nur EINMAL vorkommen.

WICHTIG -- ANTWORT-ZUORDNUNG:
Bitte werte die erkennbaren Antworten (z.B. Radiobuttons, Dropdowns, Checkboxen, offene Textfelder, Slider auf Skala 1-7) in der Reihenfolge ihres Auftretens aus.
Falls ein Fragebogen als Kontext mitgeliefert wird, nutze diesen zwingend, um die Antworten den korrekten Fragen (z.B. F1, F2, F3 etc.) zuzuordnen. Nutze EXAKT die Bezeichnungen (F1, F2...) aus dem Fragebogen.
${fragebogen ? `\nHIER IST DER FRAGEBOGEN ALS KONTEXT:\n---\n${fragebogen}\n---\n\nOrdne die Antworten chronologisch den Fragen in diesem Fragebogen zu (F1, F2, ...).` : ''}

OUTPUT-FORMAT (verbindlich):
Gib AUSSCHLIESSLICH ein valides JSON zurück (ohne Markdown Code Blocks, ohne Kommentar, ohne Prefix). Genau diese Struktur, genau diese Keys:
{
  "profil": {
    "Rolle": "Extrahierter Wert oder leerer String",
    "Geschlecht": "Extrahierter Wert oder leerer String",
    "Alter": "Extrahierter Wert oder leerer String",
    "Nationalitaet": "Extrahierter Wert oder leerer String",
    "Haushalt": "Extrahierter Wert oder leerer String",
    "Ausbildung": "Extrahierter Wert oder leerer String",
    "Berufserfahrung": "Extrahierter Wert oder leerer String",
    "Wohnsitzland": "Extrahierter Wert oder leerer String",
    "Postleitzahl": "Extrahierter Wert oder leerer String",
    "Avatar_Eigenschaften_und_Praeferenzen": "Weiteres wie z.B. Beruf etc."
  },
  "antworten": {
    "F1": "Beispiel Antwort Text",
    "F2": "Technologie & Software",
    "F3": 5,
    "F4": "Hybrid"
  }
}

Regeln für das JSON:
- Die 10 Profil-Keys sind FIX (genau diese Schreibweise, auch wenn ein Wert leer ist -> dann leerer String "").
- Die antworten-Keys sind dynamisch (F1, F2, ..., Q1, Q2, ...) und folgen der Numerierung im Fragebogen.
- Likert-Antworten (1-7) als Zahl ausgeben, NICHT als String.
- Mehrfachauswahl als kommaseparierter String (z.B. "1, 3, 5").
- Freitext-Antworten als String.
- Wenn eine Frage im Bild-Stapel nicht auftaucht: Key weglassen (NICHT mit leerem Wert eintragen).`;
}
