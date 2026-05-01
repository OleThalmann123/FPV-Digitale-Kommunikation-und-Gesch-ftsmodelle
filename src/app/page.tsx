'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';

// Custom hook for localStorage that handles hydration
function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (item) {
        setStoredValue(JSON.parse(item));
      }
    } catch (error) {
      console.warn('Error reading localStorage', error);
    }
  }, [key]);

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.warn('Error setting localStorage', error);
    }
  };

  return [storedValue, setValue] as const;
}
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { processPrompt, ModelConfig } from './actions';
import { extractFromImages } from './client-actions';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LayoutDashboard, FlaskConical, Download, Settings, Key, Info, History, Image as ImageIcon, Upload, Plus, Trash2, X, PlusCircle, Database } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';

// Bringt eine LLM-Antwort in ein analyseförmiges Skalar:
// - Likert (Zahl 1-7)  -> number
// - Single-Choice      -> string
// - Mehrfachauswahl    -> "A | B | C"
// - Ranking            -> "1. AI-Tools | 2. Analytics | ..."
// - Freitext (Q1-Q3)   -> string
function normalizeAnswerValue(raw: any): string | number {
  if (raw === null || raw === undefined) return '';
  if (Array.isArray(raw)) {
    if (raw.length === 0) return '';
    if (typeof raw[0] === 'object' && raw[0] !== null && ('rang' in raw[0] || 'rank' in raw[0] || 'kategorie' in raw[0] || 'category' in raw[0])) {
      const sorted = [...raw].sort((a, b) => Number(a.rang ?? a.rank ?? 99) - Number(b.rang ?? b.rank ?? 99));
      return sorted
        .map(item => `${item.rang ?? item.rank ?? '?'}. ${item.kategorie ?? item.category ?? item.label ?? ''}`.trim())
        .join(' | ');
    }
    return raw.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' | ');
  }
  if (typeof raw === 'object') {
    return JSON.stringify(raw);
  }
  const scStr = String(raw).trim();
  const scMatch = scStr.match(/^([1-7])$/);
  if (scMatch) return Number(scMatch[1]);
  return scStr;
}

// Mappt Frage-Identifier auf einheitlichen Schlüssel: numerische Fragen -> "F<n>", Q1-Q3 -> "Q<n>".
function canonicalQuestionKey(fn: any): string | null {
  if (fn === null || fn === undefined) return null;
  const raw = String(fn).trim();
  if (!raw) return null;
  const qMatch = raw.match(/^q[_\s]*?(\d+)$/i) || raw.match(/^qual[_\s]*?(\d+)$/i);
  if (qMatch) return `Q${qMatch[1]}`;
  const fNum = raw.replace(/[^\d]/g, '');
  if (!fNum) return null;
  return `F${fNum}`;
}

function parseAnswers(responseText: string): Record<string, string | number> {
  let bestScores: Record<string, string | number> = {};
  if (!responseText) return bestScores;

  let jsonString = responseText;
  const jsonBlockMatch = responseText.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/);
  if (jsonBlockMatch) {
    jsonString = jsonBlockMatch[1];
  } else {
    const firstBrace = responseText.indexOf('{');
    const lastBrace = responseText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonString = responseText.substring(firstBrace, lastBrace + 1);
    }
  }

  let jsonSuccess = false;
  try {
    const parsed = JSON.parse(jsonString);
    const bewertungen = parsed.bewertungen || parsed.Bewertungen || parsed.results || parsed.fragen || (Array.isArray(parsed) ? parsed : null);
    if (Array.isArray(bewertungen) && bewertungen.length > 0) {
      for (const b of bewertungen) {
        const fn = b.frage ?? b.Frage ?? b.id ?? b.question;
        let sc = b.score ?? b.Score ?? b.bewertung ?? b.Bewertung ?? b.wert ?? b.antwort ?? b.Antwort ?? b.ranking ?? b.Ranking ?? b.text;
        const key = canonicalQuestionKey(fn);
        if (key && sc !== undefined) {
          bestScores[key] = normalizeAnswerValue(sc);
          jsonSuccess = true;
        }
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const targetObj = parsed.antworten || parsed;
      for (const [k, v] of Object.entries(targetObj)) {
        const key = canonicalQuestionKey(k);
        if (key) {
          bestScores[key] = normalizeAnswerValue(v);
          jsonSuccess = true;
        }
      }
    }
  } catch (e) { }

  if (jsonSuccess && Object.keys(bestScores).length > 0) {
    return bestScores;
  }

  let regexs = [
    /"frage"\s*:\s*.*?(\d+).*?"(?:antwort|score)"\s*:\s*"?([^"}]+)"?/gi,
    /\[?\*?\*?Frage\s*(\d+)\*?\*?\s*\]?[\s:=-]+\[?\*?\*?([^\n\*\]]+)\*?\*?\]?/gi,
    /Frage\s*(\d+).*?(?:antwort|score|bewertung).*?([^\n]+)/gi
  ];

  for (let r of regexs) {
    let currentScores: Record<string, string | number> = {};
    let match;
    while ((match = r.exec(responseText)) !== null) {
      const val = match[2].trim().replace(/",?$/, '').replace(/^"/, '');
      const numMatch = val.match(/^([1-7])$/);
      currentScores[`F${match[1]}`] = numMatch ? parseInt(numMatch[1], 10) : val;
    }
    if (Object.keys(currentScores).length > Object.keys(bestScores).length) {
      bestScores = currentScores;
    }
  }

  return bestScores;
}

const PROFILE_VARIABLES = [
  'Rolle',
  'Geschlecht',
  'Alter',
  'Nationalitaet',
  'Haushalt',
  'Ausbildung',
  'Berufserfahrung',
  'Wohnsitzland',
  'Postleitzahl',
  'Avatar_Eigenschaften_und_Praeferenzen'
];

const AVAILABLE_ROLES = [
  'CEM (Customer Experience Manager)',
  'SMM (Social Media Manager)',
  'DMM (Digital Manager)',
  'Growth Manager',
  'Kommunikation Manager',
  'Webseiten Manager'
];
export default function PromptPlatform() {
  const [mounted, setMounted] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<'generator' | 'dashboard' | 'settings' | 'historie' | 'manual'>('generator');
  const [dashboardRoleFilter, setDashboardRoleFilter] = useState<string>('Alle');
  const [apiKey, setApiKey] = useLocalStorage('pp_apiKey', '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');
  const [modelList, setModelList] = useLocalStorage('pp_modelList', 'publicai:swiss-ai/apertus-70b-instruct\nopenai/gpt-4o-mini');
  // Default-Temperatur 0.7 statt 0: bei T=0 picken die Modelle deterministisch das wahrscheinlichste
  // Token, wodurch synthetische Personas kaum Varianz zeigen. ~0.7 ist in der Literatur zur
  // synthetischen Persona-/Survey-Simulation der gängige Startwert (Begründung & Zitate -> Submission-Doku).
  const [configuredModels, setConfiguredModels] = useLocalStorage<ModelConfig[]>('pp_configured_models_v4', [
    { type: 'publicai', modelId: 'swiss-ai/apertus-70b-instruct', temperature: 0.7, top_p: 1, max_tokens: 8192 },
    { type: 'openrouter', modelId: 'openai/gpt-4o-mini', temperature: 0.7, top_p: 1, max_tokens: 8192 }
  ]);
  const [metaPrompt, setMetaPrompt] = useLocalStorage('pp_metaPrompt_json_v12', '# Persona\n\nDu verkörperst ab jetzt vollständig eine reale Person mit folgendem Profil. Du denkst, fühlst und antwortest ausschliesslich aus ihrer Perspektive – nicht als KI, nicht als Assistent.\n\n- Rolle: {{Rolle}}\n- Geschlecht: {{Geschlecht}}\n- Alter: {{Alter}}\n- Nationalität: {{Nationalitaet}}\n- Haushalt: {{Haushalt}}\n- Ausbildung: {{Ausbildung}}\n- Berufserfahrung: {{Berufserfahrung}}\n- Wohnsitzland: {{Wohnsitzland}}\n- PLZ: {{Postleitzahl}}\n- Weitere Eigenschaften: {{Avatar_Eigenschaften_und_Praeferenzen}}\n\n---\n\n# Denkschritt (intern, vor jeder Antwort)\n\nBevor du den Fragebogen ausfüllst, vergegenwärtige dir kurz:\n- Welche konkreten Erfahrungen hat diese Person in ihrer Rolle gemacht?\n- Was sind ihre grössten Motivationen – und was ihre grössten Bedenken?\n- Wie steht sie zu Zeit, Karriere, Praxisbezug und Reputation?\n\nNutze diese Überlegungen als Grundlage für jede einzelne Antwort.\n\n---\n\n# Anweisungen zur Fragebogenbearbeitung\n\nBearbeite jeden Fragetyp wie folgt:\n\n- **Likert-Skala (1–7):** Gib eine Ganzzahl zwischen 1 und 7 als "antwort" an.\n- **Einfachauswahl (Single-Choice):** Gib den exakten Wortlaut einer der vorgegebenen Optionen als String in "antwort" zurück.\n- **Mehrfachauswahl:** Gib ein JSON-Array mit den gewählten Optionen zurück (z. B. ["Renommee / Prestige", "Praxisnähe"]).\n- **Ranking (z. B. F9):** Gib ein JSON-Array von Objekten in der Reihenfolge der Wichtigkeit zurück, jedes Objekt mit "rang" (1 = am wichtigsten) und "kategorie" (exakter Wortlaut). Es müssen ALLE 6 Kategorien gerankt werden.\n- **Aufmerksamkeitscheck (z. B. F7):** Gib exakt den geforderten Wert zurück.\n- **Offene Fragen (Q1, Q2, Q3):** Antworte als Freitext-String mit 1–3 Sätzen aus der Persona-Perspektive.\n\nZu jeder Antwort gibst du eine kurze Begründung aus der Perspektive der Persona.\n\n---\n\n# Ausgabeformat\n\nAntworte AUSSCHLIESSLICH in validem JSON. Keine Einleitung, kein Markdown, kein ```json-Block.\n\n{\n  "persona_reflexion": "2–3 Sätze: Wie denkt diese Person über das Thema? Was treibt sie an, was bremst sie?",\n  "bewertungen": [\n    { "frage": 1, "antwort": 5, "begruendung": "Kurze Begründung." },\n    { "frage": 3, "antwort": ["Renommee / Prestige", "Praxisnähe"], "begruendung": "..." },\n    { "frage": 9, "antwort": [ {"rang": 1, "kategorie": "AI-Tools (z. B. ChatGPT, Midjourney)"}, {"rang": 2, "kategorie": "Analytics & Data (z. B. GA4, Tableau)"}, {"rang": 3, "kategorie": "Marketing-Automation (z. B. HubSpot, Salesforce)"}, {"rang": 4, "kategorie": "Content & Social Media Tools"}, {"rang": 5, "kategorie": "SEO / Performance Marketing Tools"}, {"rang": 6, "kategorie": "Collaboration & Productivity Tools"} ], "begruendung": "..." },\n    { "frage": "Q1", "antwort": "Mir fehlen vor allem Themen wie ...", "begruendung": "..." }\n  ]\n}\n\n---\n\n# Fragebogen\n\n{{Fragebogen}}\n\n---\n\nDeine JSON-Antwort:');
  const [fragebogen, setFragebogen] = useLocalStorage('pp_fragebogen_v6', `SEKTION A - Reputation & Hochschulmarke (H1)
F1. «Die Reputation einer Hochschule ist für mich ein entscheidender Faktor bei der Wahl eines CAS-Programms.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F2. «Ein CAS-Abschluss der HSG hätte für meine berufliche Positionierung einen höheren Wert als ein gleichwertiges Programm einer weniger renommierten Institution.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F3. Welche der folgenden Aspekte verbinden Sie mit der Marke HSG? (Mehrfachauswahl möglich) Renommee / Prestige | Hohe Lehrqualität | Praxisnähe | Internationales Netzwerk | Innovation / Digitalisierung | Teuer / Elitär | Kenne HSG kaum

SEKTION B - KI-Regulierung & Rechtliche Grundlagen (H2)
F4. «Die Integration rechtlicher Grundlagen zu KI, Datenschutz und Regulierung wäre für mich ein wertvoller Bestandteil eines CAS-Programms im Bereich Marketing & Digital.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F5. Welche rechtlichen oder regulatorischen Themen sind für Ihre tägliche Arbeit relevant? (Mehrfachauswahl möglich) Datenschutz / DSGVO | KI-Regulierung (EU AI Act) | Urheberrecht & Content-IP | Wettbewerbsrecht / Advertising | Compliance & Governance | Keines davon
F6. «Ein CAS-Programm, das KI-Regulierung und Datenschutz explizit thematisiert, würde ich gegenüber einem Programm ohne diese Inhalte bevorzugen.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)

SEKTION C - Tool-Kompetenzen & Praxisrelevanz (H3)
F7. Aufmerksamkeitscheck — Bitte wählen Sie ausschliesslich den Wert 2. (Antwort: 2)
F8. «Die explizite Vermittlung konkreter digitaler Tools (z. B. Analytics-, Marketing-Automation- oder AI-Tools) würde die Attraktivität eines CAS-Programms für mich deutlich erhöhen.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F9. Welche Tool-Kategorien sind für Ihre berufliche Weiterentwicklung am relevantesten? Bitte alle 6 Kategorien in eine Reihenfolge bringen (1 = am wichtigsten, 6 = am unwichtigsten). Antworte als Ranking (Liste mit Rang + Kategorie). Kategorien: AI-Tools (z. B. ChatGPT, Midjourney) | Marketing-Automation (z. B. HubSpot, Salesforce) | Analytics & Data (z. B. GA4, Tableau) | Content & Social Media Tools | SEO / Performance Marketing Tools | Collaboration & Productivity Tools
F10. «Fehlende Tool-Kompetenzen sind aktuell eine konkrete Lücke in meinem beruflichen Alltag, die ich durch eine Weiterbildung schliessen möchte.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)

SEKTION D - Englischsprachiges Angebot (H4)
F11. Welche Unterrichtssprache bevorzugen Sie für ein CAS-Programm? Ausschliesslich Deutsch / Überwiegend Deutsch, etwas Englisch / Gemischt (50/50) / Überwiegend Englisch / Ausschliesslich Englisch
F12. «Ein englischsprachiges Programm würde die internationale Verwertbarkeit des CAS-Abschlusses für mich erhöhen.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F13. «In meinem beruflichen Umfeld wird Englisch als primäre Arbeitssprache verwendet.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)

SEKTION E - Zeit & Terminplanung (H5 - NEU)
F14. Welcher Wochentag ist für Sie als Präsenztag eines CAS-Programms am besten geeignet? Freitag / Samstag / Beides akzeptabel / Wochentags (Mo–Do) / Kein Unterschied
F15. «Drei geblockte Präsenztage pro Modul sind für mich zeitlich akzeptabel.» (1: Überhaupt nicht akzeptabel - 7: Vollständig akzeptabel)
F16. «Ein Rhythmus von Präsenzblöcken ungefähr alle zwei Monate würde meiner bevorzugten Lernintensität entsprechen.» (1: Viel zu selten / zu häufig - 7: Genau richtig)
F17. Wie viele Monate Gesamtdauer empfinden Sie als ideal für ein CAS-Programm? Bis 6 Monate / 7-9 Monate / 10-12 Monate / Über 12 Monate / Ist mir nicht wichtig

SEKTION F - Praxisorientierte Lernformate (H6)
F18. «Hands-on-Projekte und reale Unternehmenscases sind für mich wichtiger als theoretische Wissensvermittlung in einer Weiterbildung.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F19. Welches Abschlussformat würden Sie für ein CAS bevorzugen? Schriftliche Prüfung / Theoretische Abschlussarbeit / Realer Unternehmensfall / Case Study / Praxisprojekt mit Unternehmen / Präsentation vor Jury
F20. «Ich würde ein CAS-Programm mit integriertem Praxisprojekt einem rein seminaristischen Format vorziehen, auch wenn es einen höheren Zeitaufwand bedeutet.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F21. (Reversed - Konsistenzcheck zu F18) «Theoretische Grundlagen ohne direkten Praxisbezug empfinde ich in einer Weiterbildung als ausreichend wertvoll.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F22. «Die Bearbeitung eines realen Unternehmensfalls als Abschlussarbeit würde den wahrgenommenen Wert des CAS für mich deutlich steigern.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)

SEKTION G - Offene Fragen (Qualitativ)
Q1. Was wären für Sie die drei wichtigsten Themen, die ein CAS im Bereich Marketing & Digitale Kommunikation unbedingt abdecken sollte? (Freitext, 1-3 Sätze)
Q2. Was vermissen Sie in bestehenden Weiterbildungsangeboten in diesem Bereich? (Freitext, 1-3 Sätze)
Q3. Stellen Sie sich vor, Sie könnten das ideale Programmformat selbst gestalten: Welcher Wochentag, welcher Rhythmus und welche Blockgrösse würden am besten passen — und warum? (Freitext, 1-3 Sätze)`);

  const roleEigenschaften: Record<string, string> = {
    'CEM (Customer Experience Manager)': `Jobbeschreibung: Verantwortet die End-to-End-Customer-Journey und sorgt für konsistente, positive Kundenerlebnisse über alle Touchpoints. Analysiert Feedback, NPS und Verhaltensdaten, um Reibungspunkte zu reduzieren und Kundenbindung zu stärken. Arbeitet eng mit Marketing, Vertrieb und Service zusammen, um Prozesse kundenzentriert zu gestalten.
Branchenwissen: Customer Experience, Customer Service, Marketing / Customer Relations
Tools & Technologien: Microsoft Office / Shopify, Microsoft PowerPoint / Marketing Automation (HubSpot/Klaviyo), Microsoft Excel / Google Ads / Google Marketing Suite
Soziale Kompetenz: Teamwork / Structured working style, Leadership / Teamwork / Collaboration, Customer Service / Organizational skills
Weitere Kenntnisse: Project Management / Customer Journey / UX, Event Management / Campaign Management, Analytical Skills / Präsentationsskills`,

    'SMM (Social Media Manager)': `Jobbeschreibung: Plant, erstellt und veröffentlicht Inhalte auf Social-Media-Kanälen und steuert das Community-Management. Beobachtet Trends, KPIs und Reichweiten, um Content-Strategien laufend zu optimieren. Setzt Paid- und Organic-Kampagnen zur Markenstärkung und Lead-Generierung um.
Branchenwissen: Digital Marketing, Marketing, E-Commerce
Tools & Technologien: Microsoft Office / Analytics & BI (Tableau/Looker/Power BI), Google Analytics / CMS (WordPress/Typo3/other), Microsoft Excel / Google Ads / Google Marketing Suite
Soziale Kompetenz: Teamwork / Teamwork / Collaboration, Communication / Analytical thinking, Project Management / Proactive / autonomous working style
Weitere Kenntnisse: Project Management / Campaign Management, Online Marketing / KPI / Analytics & Reporting, Social Media / Performance Marketing`,

    'DMM (Digital Manager)': `Jobbeschreibung: Steuert digitale Kanäle und Massnahmen, um Marken sichtbar zu machen und die Online-Performance zu steigern. Verantwortet Strategie und Umsetzung von SEO, SEA, E-Mail, Display und Social Ads. Analysiert Performance-Daten und optimiert Budgets entlang des Funnels.
Branchenwissen: Social Media Marketing / Content Creation, Digital Marketing / Kommunikation, Social Media / Partnerschaften
Tools & Technologien: Microsoft Office / Adobe Creative Suite, Microsoft PowerPoint / Social Media Platforms (FB/TikTok/IG), Microsoft Word / CMS / Typo3
Soziale Kompetenz: Teamwork / Teamwork / Collaboration, Leadership / Structured working style, Communication / Proactive / autonomous
Weitere Kenntnisse: Social Media / Social Media Strategy, Sales / Content Strategy & Planning, Project Management / Video & Photo Production`,

    'Growth Manager': `Jobbeschreibung: Treibt skalierbares Nutzer- und Umsatzwachstum durch experimentelle Massnahmen entlang des gesamten Funnels. Nutzt Daten, Hypothesen und schnelle Tests, um Akquise, Aktivierung und Retention zu verbessern. Arbeitet eng mit Produkt, Marketing und Engineering zusammen.
Branchenwissen: Digital Marketing / Website Development, SEO / Digital Marketing, Web Design / Website security
Tools & Technologien: WordPress / CMS (WordPress/Typo3/other), HTML / HTML / CSS, Google Analytics / Dev tools (Git/Docker/CI/CD)
Soziale Kompetenz: Teamwork / Teamwork / Collaboration, Communication / Technical leadership, Project Management / Cross-functional collaboration
Weitere Kenntnisse: Social Media / Technical Architecture / DevOps, SEO / Website Operations / Content Publishing, Marketing Strategy / Customer Journey / UX`,

    'Kommunikation Manager': `Jobbeschreibung: Verantwortet die interne und externe Kommunikation und sichert eine konsistente Markenstimme. Plant Pressemitteilungen, Statements, Krisenkommunikation und Stakeholder-Dialoge. Schreibt Inhalte, briefed Agenturen und steuert den Content-Kalender.
Branchenwissen: Event Management / Kommunikation, Digital Marketing / Strategische Kommunikationsplanung, Corporate Communications / Stakeholderkommunikation
Tools & Technologien: Microsoft Office / MS 365 / Content Management Systems, Adobe InDesign / Social Media / Monitoring tools, Adobe Photoshop / Digitale Kanäle / Content Formate
Soziale Kompetenz: Teamwork / Communication, Social Media / Teamwork / Collaboration, Communication / Strategic thinking
Weitere Kenntnisse: Project Management / Strategic Communications, Marketing Strategy / Project Management, SEO / Leadership`,

    'Webseiten Manager': `Jobbeschreibung: Verantwortet Konzeption, Pflege und Weiterentwicklung der Unternehmenswebsite. Überwacht Performance, SEO, UX und Conversion und steuert Anpassungen mit Entwicklung und Design. Sorgt für rechtssichere, barrierearme Inhalte und einen reibungslosen technischen Betrieb.
Branchenwissen: Marketing / Digital Media and publishing, Customer Service / Fintec, Blockchain, stablecoin, FMCG / AI Governance and Compliance
Tools & Technologien: Microsoft Office / Google Analytics / GA4, Microsoft Excel / Meta Ads / Google Ads, Microsoft PowerPoint / Marketing Automation platforms
Soziale Kompetenz: Leadership / Data-driven mindset, Teamwork / Strategic thinking, Communication / Cross-functional collaboration
Weitere Kenntnisse: Project Management / Funnel Optimization / A/B Testing, Marketing Strategy / Campaign Management, Campaign Management / Performance Marketing`
  };

  // Persona-Splitter so eingestellt, dass die LLMs ebenfalls genau 24 Personas produzieren --
  // gleich viele wie der Demoscope-Datensatz. Aufteilung: 6 Rollen x 2 Geschlechter
  // x 1 Alter-Range x 1 Erfahrungs-Range x 1 Ausbildung (Bachelor) x 2 Haushalt x 1 PLZ = 24.
  // Alter & Erfahrung als zusammenhängende Range-Strings -> bei T=0.7 wählt das Modell intern
  // pro Run einen plausiblen Wert, das gibt zusätzliche Varianz ohne die Combos zu erhöhen.
  // Haushalt-Splitter (Single vs. Familie) macht Familien-Bias bei H5 (Saturday/Zeit) sichtbar.
  // Erfahrungs-Range pro Rolle aus manueller Recherche (Ole, Screenshot 27.04.2026), Alter
  // einheitlich 30-39 Jahre für die ganze Studie.
  const roleWorkExperience: Record<string, string> = {
    'CEM (Customer Experience Manager)': '5-7 Jahre',
    'SMM (Social Media Manager)': '3-5 Jahre',
    'DMM (Digital Manager)': '3-4 Jahre',
    'Growth Manager': '3-4 Jahre',
    'Kommunikation Manager': '4-6 Jahre',
    'Webseiten Manager': '5-7 Jahre'
  };

  const defaultRoleVars = AVAILABLE_ROLES.reduce((acc, role) => {
    acc[role] = {
      Geschlecht: 'Männlich, Weiblich',
      Alter: '30-39 Jahre',
      Nationalitaet: 'Schweiz',
      Haushalt: '1 Person kein Kind, 2 Personen 1 Kind',
      Ausbildung: 'Bachelor',
      Berufserfahrung: roleWorkExperience[role] || '3-5 Jahre',
      Wohnsitzland: 'Schweiz',
      Postleitzahl: '9000',
      Avatar_Eigenschaften_und_Praeferenzen: roleEigenschaften[role] || ''
    };
    return acc;
  }, {} as Record<string, Record<string, string>>);

  const [activeRoles, setActiveRoles] = useLocalStorage<string[]>('pp_active_roles_v6', AVAILABLE_ROLES);
  const [roleVariables, setRoleVariables] = useLocalStorage<Record<string, Record<string, string>>>('pp_role_vars_v27', defaultRoleVars);

  const variables = PROFILE_VARIABLES;
  const [results, setResults] = useState<{ id: string; promptSent: string; response: string; status: 'pending' | 'loading' | 'success' | 'error'; combo: Record<string, string>; modelId: string; modelConfig?: ModelConfig }[]>([]);
  const [historicRuns, setHistoricRuns] = useState<any[]>([]);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  // Demoscope-Upload: Eine einzige Quelle, eine Stapel-Extraktion. Alle Personas landen automatisch
  // als virtuelles Modell `Demoscope` im combinedResults-Stream und damit in Dashboard/Excel/Aggregat.
  type DemoscopePersona = {
    id: string;
    images: string[];
    combo: Record<string, string>;
    response: string;
    status: 'pending' | 'loading' | 'success' | 'error';
    error?: string;
  };

  type DemoscopeUpload = {
    images: string[];           // alle hochgeladenen Screenshots in Reihenfolge (flache Liste, Preview)
    pagesPerPersona: number;    // wie viele Screenshots gehören zu EINER Persona (nur fuer flachen Upload)
    modelName: string;          // erscheint als modelId im Dashboard
    status: 'idle' | 'extracting' | 'done';
    results: DemoscopePersona[];
    // Beim Ordner-Upload (webkitdirectory) gruppiert der Browser bereits pro Persona-Ordner.
    // Wenn gesetzt, ueberschreibt das die pagesPerPersona-Logik: 1 Gruppe = 1 Persona = 1 Vision-Call.
    imageGroups?: string[][];
    groupLabels?: string[];     // Persona-Ordnernamen (z. B. "CEM-m-30-39-CH-1PkK-...")
  };

  const [demoscope, setDemoscope] = useLocalStorage<DemoscopeUpload>('pp_demoscope_v1', {
    images: [],
    pagesPerPersona: 1,
    modelName: 'Demoscope',
    status: 'idle',
    results: []
  });
  const [includeOfflineData, setIncludeOfflineData] = useLocalStorage('pp_include_offline_data', true);

  // ==================== Demoscope-Upload: smartes Stapel-Extraktion ====================

  const fileListToBase64 = async (files: File[]): Promise<string[]> => {
    return Promise.all(files.map(file => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target?.result as string);
      reader.readAsDataURL(file);
    })));
  };

  const handleDemoscopeAddImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    // Sortiere nach Dateiname, damit die User-Reihenfolge auch bei Multi-Select stimmt.
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const newImages = await fileListToBase64(files);
    // Flacher Upload: kollidiert mit Ordner-Gruppen, also Gruppen verwerfen.
    setDemoscope(prev => ({
      ...prev,
      images: [...prev.images, ...newImages],
      imageGroups: undefined,
      groupLabels: undefined,
      status: 'idle',
      results: []
    }));
  };

  // Ordner-Upload: gruppiert Screenshots automatisch nach direktem Eltern-Ordner
  // (webkitRelativePath = "Profile/CEM-m-.../screenshot.png"). Eine Gruppe = eine Persona.
  const handleDemoscopeAddFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const grouped = new Map<string, File[]>();
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = relPath.split('/');
      // Direkter Eltern-Ordner = vorletztes Pfadelement; bei flacher Liste -> "(Wurzel)".
      const parent = parts.length >= 2 ? parts[parts.length - 2] : '(Wurzel)';
      if (!grouped.has(parent)) grouped.set(parent, []);
      grouped.get(parent)!.push(file);
    }

    if (grouped.size === 0) return;

    const sortedFolders = Array.from(grouped.keys()).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );

    const groupLabels: string[] = [];
    const imageGroups: string[][] = [];
    const flatImages: string[] = [];

    for (const folder of sortedFolders) {
      const folderFiles = grouped.get(folder)!;
      folderFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const base64s = await fileListToBase64(folderFiles);
      groupLabels.push(folder);
      imageGroups.push(base64s);
      flatImages.push(...base64s);
    }

    setDemoscope(prev => ({
      ...prev,
      images: flatImages,
      imageGroups,
      groupLabels,
      status: 'idle',
      results: []
    }));
  };

  const handleDemoscopeRemoveImage = (index: number) => {
    setDemoscope(prev => {
      const newImages = prev.images.filter((_, i) => i !== index);
      // Wenn Ordner-Gruppen aktiv sind, auch dort die richtige Stelle entfernen.
      if (prev.imageGroups && prev.imageGroups.length > 0) {
        let cursor = 0;
        const groups: string[][] = [];
        const labels: string[] = [];
        prev.imageGroups.forEach((g, gi) => {
          const size = g.length;
          let updated = g;
          if (index >= cursor && index < cursor + size) {
            updated = g.filter((_, i) => i !== index - cursor);
          }
          if (updated.length > 0) {
            groups.push(updated);
            labels.push(prev.groupLabels?.[gi] || '');
          }
          cursor += size;
        });
        return {
          ...prev,
          images: newImages,
          imageGroups: groups.length > 0 ? groups : undefined,
          groupLabels: groups.length > 0 ? labels : undefined,
          status: 'idle',
          results: []
        };
      }
      return { ...prev, images: newImages, status: 'idle', results: [] };
    });
  };

  const handleDemoscopeReset = () => {
    setDemoscope({
      images: [],
      pagesPerPersona: 1,
      modelName: 'Demoscope',
      status: 'idle',
      results: [],
      imageGroups: undefined,
      groupLabels: undefined
    });
  };

  const handleDemoscopePagesChange = (n: number) => {
    setDemoscope(prev => ({ ...prev, pagesPerPersona: Math.max(1, n), status: 'idle', results: [] }));
  };

  const handleDemoscopeModelNameChange = (name: string) => {
    setDemoscope(prev => ({ ...prev, modelName: name }));
  };

  // Bei vielen Screenshots pro Persona (z. B. 30 WhatsApp-Bilder) hilft es, in
  // Sub-Batches an die Vision-API zu schicken: GPT-4o haelt sich dann pro Call
  // an weniger Material und uebersieht weniger Antworten. Die Teil-JSONs werden
  // anschliessend gemerged: Profil-Felder per "first non-empty wins" (Profil
  // sollte ueberall identisch sein), Antworten per Object.assign (jede Frage
  // taucht idealerweise in genau einem Sub-Batch auf).
  const SUB_CHUNK_SIZE = 10;
  const tryParseVisionJson = (raw: string): { profil?: Record<string, string>; antworten?: Record<string, unknown> } => {
    try {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonString = match ? match[1] : raw;
      return JSON.parse(jsonString);
    } catch {
      return {};
    }
  };
  const extractPersonaInChunks = async (images: string[]): Promise<string> => {
    if (images.length <= SUB_CHUNK_SIZE) {
      return extractFromImages(images, apiKey, fragebogen);
    }
    const subBatches: string[][] = [];
    for (let i = 0; i < images.length; i += SUB_CHUNK_SIZE) {
      subBatches.push(images.slice(i, i + SUB_CHUNK_SIZE));
    }
    const mergedProfile: Record<string, string> = {};
    const mergedAnswers: Record<string, unknown> = {};
    let firstError: Error | null = null;
    for (const sub of subBatches) {
      try {
        const raw = await extractFromImages(sub, apiKey, fragebogen);
        const parsed = tryParseVisionJson(raw);
        if (parsed.profil) {
          for (const [k, v] of Object.entries(parsed.profil)) {
            if (v && !mergedProfile[k]) mergedProfile[k] = String(v);
          }
        }
        if (parsed.antworten) {
          Object.assign(mergedAnswers, parsed.antworten);
        }
      } catch (e) {
        if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
      }
    }
    // Wenn keine einzige Antwort durchkam, Fehler hochreichen statt leeres JSON.
    if (Object.keys(mergedAnswers).length === 0 && Object.keys(mergedProfile).length === 0 && firstError) {
      throw firstError;
    }
    return JSON.stringify({ profil: mergedProfile, antworten: mergedAnswers });
  };

  // Liest die rohe Vision-Antwort und baut combo + canonical response auf.
  const parseDemoscopeExtraction = (raw: string): { combo: Record<string, string>, response: string } => {
    let extractedData: any = {};
    try {
      let jsonString = raw;
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) jsonString = match[1];
      extractedData = JSON.parse(jsonString);
    } catch (e) {
      // raw bleibt als Response erhalten -- parseAnswers fängt das später per Regex auf
    }
    const combo: Record<string, string> = {
      Rolle: extractedData.profil?.Rolle || 'Unbekannt',
    };
    variables.forEach(v => {
      if (v !== 'Rolle') combo[v] = extractedData.profil?.[v] || '';
    });
    return { combo, response: raw };
  };

  const runDemoscopeExtraction = async (opts?: { limit?: number }) => {
    if (!apiKey) {
      alert('Bitte API Key (OpenRouter) in den Settings eintragen, um die Vision API (GPT-4o) zu nutzen.');
      return;
    }
    if (demoscope.images.length === 0) return;

    // Ordner-Upload setzt imageGroups (1 Persona = 1 Ordner = 1 Vision-Call).
    // Flacher Upload faellt auf pagesPerPersona-Chunking zurueck.
    let chunks: string[][];
    let labels: (string | undefined)[];
    if (demoscope.imageGroups && demoscope.imageGroups.length > 0) {
      chunks = demoscope.imageGroups;
      labels = demoscope.groupLabels || [];
    } else {
      const pp = Math.max(1, demoscope.pagesPerPersona);
      chunks = [];
      for (let i = 0; i < demoscope.images.length; i += pp) {
        chunks.push(demoscope.images.slice(i, i + pp));
      }
      labels = chunks.map(() => undefined);
    }
    // Optionales Limit (z. B. "Nur 1 Persona testen") -- spart Vision-Kosten beim Probelauf.
    if (opts?.limit && opts.limit > 0 && opts.limit < chunks.length) {
      chunks = chunks.slice(0, opts.limit);
      labels = labels.slice(0, opts.limit);
    }
    const ts = Date.now();
    const initialResults: DemoscopePersona[] = chunks.map((imgs, i) => ({
      id: `offline-demoscope-${ts}-${i}`,
      images: imgs,
      combo: { Rolle: labels[i] ? `Erkenne... (${labels[i]})` : 'Erkenne...' },
      response: '',
      status: 'pending'
    }));
    setDemoscope(prev => ({ ...prev, status: 'extracting', results: initialResults }));

    // Sequenziell, um die Vision-API nicht zu überlasten und Kosten zu kontrollieren.
    for (let i = 0; i < chunks.length; i++) {
      setDemoscope(prev => ({
        ...prev,
        results: prev.results.map((r, idx) => idx === i ? { ...r, status: 'loading' } : r)
      }));
      try {
        const raw = await extractPersonaInChunks(chunks[i]);
        const { combo, response } = parseDemoscopeExtraction(raw);
        setDemoscope(prev => ({
          ...prev,
          results: prev.results.map((r, idx) => idx === i ? { ...r, status: 'success', combo, response } : r)
        }));
      } catch (err: any) {
        setDemoscope(prev => ({
          ...prev,
          results: prev.results.map((r, idx) => idx === i ? { ...r, status: 'error', error: err?.message || 'Vision API Fehler' } : r)
        }));
      }
    }
    setDemoscope(prev => ({ ...prev, status: 'done' }));
  };


  const fetchHistory = async () => {
    const { data } = await supabase
      .from('prompt_runs')
      .select('*')
      .order('created_at', { ascending: false });
    if (data) setHistoricRuns(data);
  };



  useEffect(() => {
    setMounted(true);
    fetchHistory();
  }, []);

  if (!mounted) return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading Platform...</div>;

  const updateRoleVariable = (role: string, key: string, value: string) => {
    setRoleVariables(prev => ({
      ...prev,
      [role]: {
        ...(prev[role] || {}),
        [key]: value
      }
    }));
  };

  const generateCombinations = () => {
    const combinations: Record<string, string>[] = [];
    const varsWithoutRole = variables.filter(v => v !== 'Rolle');

    activeRoles.forEach(role => {
      const roleVars = roleVariables[role] || {};
      const parsedOptions: Record<string, string[]> = {};

      for (const v of varsWithoutRole) {
        const val = roleVars[v] || '';
        if (v === 'Avatar_Eigenschaften_und_Praeferenzen') {
          parsedOptions[v] = [val];
        } else {
          const split = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
          parsedOptions[v] = split.length > 0 ? split : [''];
        }
      }

      const roleCombos: Record<string, string>[] = [];
      const helper = (currentIndex: number, currentCombo: Record<string, string>) => {
        if (currentIndex === varsWithoutRole.length) {
          roleCombos.push({ ...currentCombo, Rolle: role });
          return;
        }
        const key = varsWithoutRole[currentIndex];
        const values = parsedOptions[key];
        for (const value of values) {
          helper(currentIndex + 1, { ...currentCombo, [key]: value });
        }
      };

      helper(0, {});
      combinations.push(...roleCombos);
    });

    return combinations;
  };



  const addModelConfig = (type: ModelConfig['type']) => {
    const newId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
    setConfiguredModels(prev => [
      ...prev,
      {
        type,
        modelId: type === 'publicai' ? 'swiss-ai/apertus-70b-instruct' : 'openai/gpt-4o-mini',
        temperature: 0,
        top_p: 1,
        max_tokens: 8192,
        id: newId
      } as ModelConfig & { id: string }
    ]);
  };

  const updateModelConfig = (index: number, key: keyof ModelConfig, value: any) => {
    setConfiguredModels(prev => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [key]: value };
      return copy;
    });
  };

  const removeModelConfig = (index: number) => {
    setConfiguredModels(prev => prev.filter((_, i) => i !== index));
  };

  const getModelsToRun = (): ModelConfig[] => {
    return configuredModels;
  };

  const runAll = async () => {
    if (isGenerating) return;
    setIsGenerating(true);

    const models = getModelsToRun();
    if (models.length === 0) {
      alert('Bitte gib mindestens ein Modell an.');
      setIsGenerating(false); // Release lock if early exit
      return;
    }
    // API key only strict required if openrouter or publicai is in models
    if (models.find(m => m.type === 'openrouter' || m.type === 'publicai') && !apiKey) {
      alert('Bitte API Key eingeben (für Cloud-Modelle).');
      setIsGenerating(false); // Release lock if early exit
      return;
    }

    const combos = generateCombinations();

    const runName = `Lauf vom ${new Date().toLocaleString('de-CH')}`;
    let dbRunId: number | null = null;

    try {
      const { data: runData, error: runError } = await supabase
        .from('prompt_runs')
        .insert({
          name: runName,
          meta_prompt_template: metaPrompt,
          fragebogen: fragebogen,
          role_variables: roleVariables,
          active_roles: activeRoles,
          models: models.map(m => m.modelId)
        })
        .select('id')
        .single();

      if (runData) {
        dbRunId = runData.id;
        setActiveRunId(runData.id);
      }
      if (runError) console.error("Error creating run in db:", runError);
    } catch (e) {
      console.error("Supabase insert error", e);
    }

    // Initialize results state
    const newResults: any[] = [];
    let idx = 0;

    // Multiple variations: per combo, run per model
    combos.forEach(combo => {
      let finalPrompt = metaPrompt;
      variables.forEach(v => {
        finalPrompt = finalPrompt.replaceAll(`{{${v}}}`, combo[v] || '');
      });
      finalPrompt = finalPrompt.replaceAll(`{{Fragebogen}}`, fragebogen || '');

      models.forEach(model => {
        newResults.push({
          id: (idx++).toString(),
          promptSent: finalPrompt,
          response: '',
          status: 'pending',
          combo: combo,
          modelConfig: model,
          modelId: model.modelId
        });
      });
    });

    setResults(newResults);

    // Process in batches of 2 to avoid aggressive rate-limiting but prevent sequential blocking
    const batchSize = 2;
    for (let i = 0; i < newResults.length; i += batchSize) {
      const batch = newResults.slice(i, i + batchSize);
      
      setResults(prev => prev.map(r => batch.find(b => b.id === r.id) ? { ...r, status: 'loading' } : r));

      await Promise.all(batch.map(async (current) => {
        try {
          const res = await processPrompt(current.promptSent, current.modelConfig, apiKey);
          setResults(prev => prev.map(r => r.id === current.id ? { ...r, status: 'success', response: res } : r));

          if (dbRunId) {
            supabase.from('prompt_run_results').insert({
              run_id: dbRunId,
              model_id: current.modelId,
              combo: current.combo,
              prompt_sent: current.promptSent,
              response: res,
              status: 'success'
            }).then(({ error }) => { if (error) console.error("Error saving result", error); });
          }
        } catch (err: any) {
          setResults(prev => prev.map(r => r.id === current.id ? { ...r, status: 'error', response: err.message || 'Error executing API' } : r));

          if (dbRunId) {
            supabase.from('prompt_run_results').insert({
              run_id: dbRunId,
              model_id: current.modelId,
              combo: current.combo,
              prompt_sent: current.promptSent,
              response: err.message || 'Error executing API',
              status: 'error'
            }).then(({ error }) => { if (error) console.error("Error saving result", error); });
          }
        }
      }));
    }
    setIsGenerating(false);
    fetchHistory();
  };

  const handleRunAndSwitch = async () => {
    runAll();
    setActiveTab('dashboard');
  };

  const loadHistoricRun = async (runId: number) => {
    setActiveRunId(runId);
    setIsGenerating(true);
    const { data: runData } = await supabase
      .from('prompt_runs')
      .select('*')
      .eq('id', runId)
      .single();

    if (runData) {
      setMetaPrompt(runData.meta_prompt_template);
      setFragebogen(runData.fragebogen);
      setRoleVariables(runData.role_variables);
      if (runData.active_roles) setActiveRoles(runData.active_roles);
      if (runData.models) setModelList(runData.models.join('\n'));
      // Wait to load results
      const { data: resultsData } = await supabase
        .from('prompt_run_results')
        .select('*')
        .eq('run_id', runId);

      if (resultsData) {
        setResults(resultsData.map((dbRes: any) => ({
          id: dbRes.id.toString(),
          promptSent: dbRes.prompt_sent,
          response: dbRes.response,
          status: dbRes.status,
          combo: dbRes.combo,
          modelId: dbRes.model_id,
          modelConfig: { type: 'openrouter', modelId: dbRes.model_id }
        })));
      }

      // Attempt to load settings from DB into configuredModels if they are saved in run
      // This is a basic migration mapping, we don't have the full model settings per run in DB yet, but we load models.
      if (runData.models) {
        const oldModelList = runData.models.join('\n');
        setModelList(oldModelList);
      }
    }
    setIsGenerating(false);
    setActiveTab('dashboard');
  };

  const currentModelsCount = getModelsToRun().length;
  const comboCount = generateCombinations().length;

  // Demoscope-Extraktionen werden hier zu virtuellen Run-Ergebnissen mit modelId = demoscope.modelName.
  // Damit landen sie automatisch in combinedResults und damit in Dashboard, Aggregat, Excel-Sheets,
  // Erfolgsquoten-Karte etc. -- gleiche Auswertung wie Apertus / gpt-4o-mini.
  const offlineResults: any[] = (demoscope.results || [])
    .filter(r => r.status === 'success' || r.status === 'error')
    .map(r => ({
      id: r.id,
      promptSent: `Demoscope-Upload (Vision OCR, ${r.images.length} Screenshot${r.images.length === 1 ? '' : 's'})`,
      response: r.status === 'success' ? r.response : (r.error || 'Vision-Extraktion fehlgeschlagen'),
      status: r.status,
      combo: r.combo,
      modelId: demoscope.modelName || 'Demoscope',
      modelConfig: { type: 'openrouter' as const, modelId: 'openai/gpt-4o' }
    }));

  const combinedResults = includeOfflineData ? [...results, ...offlineResults] : [...results];

  const filteredResultsAll = combinedResults.filter(r => {
    let roleName = r.combo['Rolle'] || 'Keine Rolle';
    if (roleName.includes('(')) roleName = roleName.split('(')[0].trim();
    if (dashboardRoleFilter !== 'Alle' && roleName !== dashboardRoleFilter) return false;
    return true;
  });

  const filteredResultsValid = filteredResultsAll.filter(r => r.status === 'success' && r.response);

  const downloadExcel = () => {
    try {
      if (filteredResultsAll.length === 0) return;

      const wb = XLSX.utils.book_new();

      // Alle in den Antworten vorkommenden Fragen sammeln (F1.. + Q1..) für konsistente Spalten.
      const allFragen = new Set<string>();
      filteredResultsAll.forEach(r => {
        const scores = parseAnswers(r.response);
        Object.keys(scores).forEach(f => allFragen.add(f));
      });
      const sortedFragen = Array.from(allFragen).sort(sortQuestions);
      const numericFragen = sortedFragen.filter(f => f.startsWith('F'));
      const qualitativeFragen = sortedFragen.filter(f => f.startsWith('Q'));

      // Quelle ableiten: offline-IDs stammen aus Demoscope-Bild-Extraktion (siehe combinedResults).
      const sourceOf = (r: any) => (typeof r.id === 'string' && r.id.startsWith('offline-')) ? 'Demoscope-Image' : 'LLM';

      // ---------- Sheet 1: Rohdaten ----------
      // Eine Zeile pro Run, alle Profil-Variablen + alle Fragen + Prompt/Response. Pivot-tauglich.
      const rawData = filteredResultsAll.map(r => {
        const rowItem: any = {
          RunID: r.id,
          Quelle: sourceOf(r),
          Modell: r.modelId,
          Status: r.status,
        };
        variables.forEach(v => {
          rowItem[v] = r.combo[v] || '';
        });
        const scores = parseAnswers(r.response);
        sortedFragen.forEach(f => {
          const v = scores[f];
          rowItem[f] = v !== undefined ? v : '';
        });
        rowItem['Prompt Sent'] = r.promptSent;
        rowItem['Response'] = r.response;
        return rowItem;
      });
      const ws1 = XLSX.utils.json_to_sheet(rawData);
      XLSX.utils.book_append_sheet(wb, ws1, "1_Rohdaten");

      // ---------- Sheet 2: Aggregat pro Modell (Mean / Stddev / Varianz / n) ----------
      const aggData = getAggregatedData();
      if (aggData.fragen.length > 0) {
        const aggRows: any[] = [];
        Object.keys(aggData.stats).forEach(modelId => {
          aggData.fragen.forEach(frage => {
            const s = aggData.stats[modelId][frage];
            const stat = s ? computeStats(s) : { mean: null, variance: null, stddev: null, n: 0 };
            aggRows.push({
              Modell: modelId,
              Frage: frage,
              n: stat.n,
              Mean: stat.mean !== null ? Number(stat.mean.toFixed(3)) : null,
              Stddev: stat.stddev !== null ? Number(stat.stddev.toFixed(3)) : null,
              Varianz: stat.variance !== null ? Number(stat.variance.toFixed(3)) : null,
            });
          });
        });
        const ws2 = XLSX.utils.json_to_sheet(aggRows);
        XLSX.utils.book_append_sheet(wb, ws2, "2_Aggregat_pro_Modell");
      }

      // ---------- Sheet 3: Aggregat pro Rolle x Modell ----------
      const averagesData = getAveragesTableData();
      if (averagesData.rows.length > 0) {
        const wideRows = averagesData.rows.map((row: any) => {
          const rowItem: any = { Rolle: row.role, Modell: row.modelId };
          averagesData.columns.forEach(col => {
            rowItem[`${col}_mean`] = row[col] !== undefined ? Number(row[col]) : null;
            rowItem[`${col}_sigma`] = row[`${col}_sigma`] !== undefined ? Number(row[`${col}_sigma`]) : null;
            rowItem[`${col}_n`] = row[`${col}_n`] !== undefined ? Number(row[`${col}_n`]) : null;
          });
          return rowItem;
        });
        const ws3 = XLSX.utils.json_to_sheet(wideRows);
        XLSX.utils.book_append_sheet(wb, ws3, "3_Aggregat_Rolle_Modell");
      }

      // ---------- Sheet 4: Dropouts ----------
      // Alle nicht-erfolgreichen Runs explizit ausweisen, damit man Apertus-504/Gateway etc. transparent
      // im Reflexionsteil dokumentieren kann.
      const dropoutRows = filteredResultsAll
        .filter(r => r.status !== 'success')
        .map(r => {
          const rowItem: any = {
            RunID: r.id,
            Quelle: sourceOf(r),
            Modell: r.modelId,
            Status: r.status,
            Fehlertext: r.response || '',
          };
          variables.forEach(v => {
            rowItem[v] = r.combo[v] || '';
          });
          return rowItem;
        });
      if (dropoutRows.length > 0) {
        const ws4 = XLSX.utils.json_to_sheet(dropoutRows);
        XLSX.utils.book_append_sheet(wb, ws4, "4_Dropouts");
      }

      // ---------- Sheet 5: Qualitativ Q1-Q3 ----------
      if (qualitativeFragen.length > 0) {
        const qualRows = filteredResultsValid.map(r => {
          const scores = parseAnswers(r.response);
          const rowItem: any = {
            RunID: r.id,
            Quelle: sourceOf(r),
            Modell: r.modelId,
            Rolle: r.combo['Rolle'] || '',
          };
          qualitativeFragen.forEach(q => {
            rowItem[q] = scores[q] !== undefined ? scores[q] : '';
          });
          return rowItem;
        }).filter(row => qualitativeFragen.some(q => row[q]));
        if (qualRows.length > 0) {
          const ws5 = XLSX.utils.json_to_sheet(qualRows);
          XLSX.utils.book_append_sheet(wb, ws5, "5_Qualitativ_Q1_Q3");
        }
      }

      XLSX.writeFile(wb, `prompt_results_${Date.now()}.xlsx`);
    } catch (err: any) {
      console.error(err);
      alert("Fehler beim Excel-Export: " + err.message);
    }
  };

  // Sortierhelfer: F-Fragen numerisch vor Q-Fragen, beide intern numerisch sortiert.
  const sortQuestions = (a: string, b: string) => {
    const isQa = a.startsWith('Q');
    const isQb = b.startsWith('Q');
    if (isQa !== isQb) return isQa ? 1 : -1;
    const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
    const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
    return numA - numB;
  };

  // Berechnet Mean/Varianz/Stddev. Nutzt Population-Varianz (E[X^2] - E[X]^2), da wir die
  // Persona-Antworten als vollständige Stichprobe der simulierten Population betrachten.
  const computeStats = (s: { sum: number, sumSq: number, count: number }) => {
    if (!s || s.count === 0) return { mean: 0, variance: 0, stddev: 0, n: 0 };
    const mean = s.sum / s.count;
    const variance = Math.max(0, s.sumSq / s.count - mean * mean);
    return { mean, variance, stddev: Math.sqrt(variance), n: s.count };
  };

  const getAggregatedData = () => {
    const groupStats: Record<string, { [frage: string]: { sum: number, sumSq: number, count: number } }> = {};
    const allFragen = new Set<string>();

    filteredResultsValid.forEach(r => {
      const scores = parseAnswers(r.response);
      const groupKey = r.modelId;

      if (!groupStats[groupKey]) groupStats[groupKey] = {};
      Object.entries(scores).forEach(([frage, score]) => {
        const numScore = Number(score);
        if (isNaN(numScore)) return; // Nicht-numerische Antworten (Mehrfachauswahl, Q1-Q3) -> separat in Sheets

        allFragen.add(frage);
        if (!groupStats[groupKey][frage]) groupStats[groupKey][frage] = { sum: 0, sumSq: 0, count: 0 };
        groupStats[groupKey][frage].sum += numScore;
        groupStats[groupKey][frage].sumSq += numScore * numScore;
        groupStats[groupKey][frage].count += 1;
      });
    });

    return {
      stats: groupStats,
      fragen: Array.from(allFragen).sort(sortQuestions)
    };
  };

  // Erfolgsquote pro Modell: success / total + Liste der Fehler. Quelle: combinedResults (inkl. Errors).
  const getModelSuccessRates = () => {
    const totals: Record<string, { success: number, error: number, pending: number, loading: number, errors: string[] }> = {};
    combinedResults.forEach(r => {
      if (!totals[r.modelId]) totals[r.modelId] = { success: 0, error: 0, pending: 0, loading: 0, errors: [] };
      if (r.status === 'success') totals[r.modelId].success += 1;
      else if (r.status === 'error') {
        totals[r.modelId].error += 1;
        if (r.response) totals[r.modelId].errors.push(String(r.response).slice(0, 200));
      }
      else if (r.status === 'pending') totals[r.modelId].pending += 1;
      else if (r.status === 'loading') totals[r.modelId].loading += 1;
    });
    return totals;
  };

  const getTableData = () => {
    const tableRows: any[] = [];
    const allFragenForTable = new Set<string>();
    const grouped: Record<string, { role: string, profile: string, modelId: string, agg: Record<string, { sum: number, sumSq: number, count: number }> }> = {};

    filteredResultsValid.forEach(r => {
      const scores = parseAnswers(r.response);
      const roleName = r.combo['Rolle'] || 'Keine Rolle';
      const simplifyRole = roleName.includes('(') ? roleName.split('(')[0].trim() : roleName;
      const modelId = r.modelId;

      const profileKeys = Object.entries(r.combo)
        .filter(([k]) => k !== 'Rolle')
        .map(([, v]) => v)
        .filter(Boolean)
        .join(', ');

      const key = `${r.id}_${simplifyRole}_${modelId}`;

      if (!grouped[key]) {
        grouped[key] = { role: simplifyRole, profile: profileKeys, modelId: modelId, agg: {} };
      }

      Object.entries(scores).forEach(([frage, score]) => {
        const numScore = Number(score);
        if (isNaN(numScore)) return;

        allFragenForTable.add(frage);
        if (!grouped[key].agg[frage]) grouped[key].agg[frage] = { sum: 0, sumSq: 0, count: 0 };
        grouped[key].agg[frage].sum += numScore;
        grouped[key].agg[frage].sumSq += numScore * numScore;
        grouped[key].agg[frage].count += 1;
      });
    });

    Object.values(grouped).forEach(g => {
      const finalRow: any = { role: g.role, profile: g.profile, modelId: g.modelId };
      Object.entries(g.agg).forEach(([frage, s]) => {
        const stat = computeStats(s);
        finalRow[frage] = stat.mean.toFixed(2);
        finalRow[`${frage}_sigma`] = stat.stddev.toFixed(2);
        finalRow[`${frage}_n`] = stat.n;
      });
      tableRows.push(finalRow);
    });

    return { rows: tableRows, columns: Array.from(allFragenForTable).sort(sortQuestions) };
  };

  const getAveragesTableData = () => {
    const tableRows: any[] = [];
    const allFragenForTable = new Set<string>();
    const grouped: Record<string, { role: string, modelId: string, agg: Record<string, { sum: number, sumSq: number, count: number }> }> = {};

    filteredResultsValid.forEach(r => {
      const scores = parseAnswers(r.response);
      const roleName = r.combo['Rolle'] || 'Keine Rolle';
      const simplifyRole = roleName.includes('(') ? roleName.split('(')[0].trim() : roleName;
      const modelId = r.modelId;

      const key = `${simplifyRole}_${modelId}`;

      if (!grouped[key]) {
        grouped[key] = { role: simplifyRole, modelId: modelId, agg: {} };
      }

      Object.entries(scores).forEach(([frage, score]) => {
        const numScore = Number(score);
        if (isNaN(numScore)) return;

        allFragenForTable.add(frage);
        if (!grouped[key].agg[frage]) grouped[key].agg[frage] = { sum: 0, sumSq: 0, count: 0 };
        grouped[key].agg[frage].sum += numScore;
        grouped[key].agg[frage].sumSq += numScore * numScore;
        grouped[key].agg[frage].count += 1;
      });
    });

    Object.values(grouped).forEach(g => {
      const finalRow: any = { role: g.role, modelId: g.modelId };
      Object.entries(g.agg).forEach(([frage, s]) => {
        const stat = computeStats(s);
        finalRow[frage] = stat.mean.toFixed(2);
        finalRow[`${frage}_sigma`] = stat.stddev.toFixed(2);
        finalRow[`${frage}_n`] = stat.n;
      });
      tableRows.push(finalRow);
    });

    return { rows: tableRows, columns: Array.from(allFragenForTable).sort(sortQuestions) };
  };

  const aggData = getAggregatedData();
  const tableData = getTableData();

  // Prepare chart data format: { name: 'Frage 1', modelA: 4.5, modelB: 5.2 }
  const chartData = aggData.fragen.map(frage => {
    const dataPoint: any = { name: frage };
    Object.keys(aggData.stats).forEach(modelId => {
      const stat = aggData.stats[modelId][frage];
      dataPoint[modelId] = stat ? Number((stat.sum / stat.count).toFixed(2)) : 0;
    });
    return dataPoint;
  });

  const getModelColors = () => {
    const colors = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#0088fe', '#00c49f', '#ff0055', '#4caf50', '#673ab7'];
    return Object.keys(aggData.stats).map((m, i) => ({ model: m, color: colors[i % colors.length] }));
  };

  const modelColors = getModelColors();
  const currentFilterN = filteredResultsValid.length;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar Navigation */}
      <aside className="w-64 border-r bg-muted/40 p-4 shrink-0 flex flex-col gap-2">
        <div className="mb-6 mt-4 px-4 flex flex-col gap-4">
          <img src="/hsg-logo.png" alt="HSG Logo" className="w-32 h-auto" />
          <h1 className="text-xl font-serif font-bold tracking-tight text-primary">Synthetic Persona Data Plattform</h1>
        </div>

        <div className="flex-1 space-y-2">
          <Button
            variant={activeTab === 'generator' ? 'secondary' : 'ghost'}
            className="justify-start gap-3 w-full"
            onClick={() => setActiveTab('generator')}
          >
            <FlaskConical className="w-4 h-4" /> Labor & Generator
          </Button>
          <Button
            variant={activeTab === 'manual' ? 'secondary' : 'ghost'}
            className="justify-start gap-3 w-full"
            onClick={() => setActiveTab('manual')}
          >
            <Database className="w-4 h-4" /> Demoscope Upload
          </Button>
          <Button
            variant={activeTab === 'dashboard' ? 'secondary' : 'ghost'}
            className="justify-start gap-3 w-full"
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard className="w-4 h-4" /> Auswertung
          </Button>
          <Button
            variant={activeTab === 'historie' ? 'secondary' : 'ghost'}
            className="justify-start gap-3 w-full"
            onClick={() => setActiveTab('historie')}
          >
            <History className="w-4 h-4" /> Historie
          </Button>
          <Button
            variant={activeTab === 'settings' ? 'secondary' : 'ghost'}
            className="justify-start gap-3 w-full"
            onClick={() => setActiveTab('settings')}
          >
            <Settings className="w-4 h-4" /> API & Modelle
          </Button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-4 md:p-8">
        <div className="w-full max-w-[1600px] mx-auto space-y-8">

          {activeTab === 'settings' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="flex items-center justify-between pb-4">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight">API Keys & Modelle</h2>
                  <p className="text-muted-foreground">Verwalte hier deine Zugangsdaten und die Auswahl der KI-Modelle.</p>
                </div>
              </div>
              <Card className="max-w-3xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Key className="w-5 h-5" /> Zugang & Provider</CardTitle>
                  <CardDescription>Trage hier deinen OpenRouter oder Public AI API-Key ein. Die verwendeten Cloud-Modelle erfordern diesen Schlüssel.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    <Label htmlFor="apiKey">Globaler API Key (OpenRouter / PublicAI)</Label>
                    <Input
                      id="apiKey"
                      type="password"
                      placeholder="sk-or-v1-..."
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="font-mono text-lg py-5"
                    />
                    <p className="text-sm text-muted-foreground mt-2">
                      Dieser API-Schlüssel wird für die Verwendung der OpenRouter Cloud Modelle herangezogen. Public AI Modelle werden (vorerst) von uns zur Verfügung gestellt. Du kannst die genauen Modelle für jeden Lauf im Generator-Tab auswählen.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'generator' && (
            <div className="w-full pb-16">
              <Tabs defaultValue="prompts" className="w-full">
                <TabsList className="mb-8 w-full flex flex-wrap h-auto md:h-16 p-1 bg-muted/50 rounded-xl">
                  <TabsTrigger value="prompts" className="flex-1 py-4 text-sm md:text-base font-semibold rounded-lg">1. Prompts</TabsTrigger>
                  <TabsTrigger value="variables" className="flex-1 py-4 text-sm md:text-base font-semibold rounded-lg">2. Variablen</TabsTrigger>
                  <TabsTrigger value="models" className="flex-1 py-4 text-sm md:text-base font-semibold rounded-lg">3. Modelle & Parameter</TabsTrigger>
                  <TabsTrigger value="generate" className="flex-1 py-4 text-sm md:text-base font-semibold rounded-lg bg-primary/10 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">4. Start & Vorschau</TabsTrigger>
                </TabsList>

                <TabsContent value="prompts" className="w-full space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <Card className="flex flex-col">
                    <CardHeader>
                      <CardTitle className="text-2xl">Generator Labor</CardTitle>
                      <CardDescription className="text-base">Definiere deinen Meta-Prompt und den Fragebogen-Input.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-8 flex-1 flex flex-col">
                      <div className="space-y-4 flex-1 flex flex-col">
                        <Label className="text-lg">Meta Prompt Template</Label>
                        <Textarea
                          className="min-h-[300px] font-mono whitespace-pre-wrap text-base p-6 bg-muted/30"
                          value={metaPrompt}
                          onChange={(e) => setMetaPrompt(e.target.value)}
                          placeholder="Enter prompt with {{variable}} tags..."
                        />
                        <div className="flex flex-wrap gap-2 items-center text-sm text-muted-foreground mt-2 bg-muted/50 p-3 rounded-md">
                          <span className="mr-1 font-medium">Verfügbare Variablen:</span>
                          {variables.map(v => <Badge variant="secondary" key={v} className="font-mono text-xs font-normal border-primary/20">{`{{${v}}}`}</Badge>)}
                          <Badge variant="secondary" className="font-mono text-xs font-normal border-primary/20">{'{{Fragebogen}}'}</Badge>
                        </div>
                      </div>

                      <div className="space-y-4 mt-4">
                        <Label className="text-lg mt-2">Fragebogen Input</Label>
                        <Textarea
                          className="min-h-[300px] font-mono text-base p-6 bg-muted/30"
                          value={fragebogen}
                          onChange={(e) => setFragebogen(e.target.value)}
                          placeholder="Hier den Fragebogen reinkopieren..."
                        />
                        <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
                          💡 Dieser Text wird überall dort eingefügt, wo du die Variable <code className="bg-background px-1.5 py-0.5 rounded border shadow-sm">{`{{Fragebogen}}`}</code> im Meta Prompt platziert hast.
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="variables" className="w-full animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="space-y-6">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-2xl">1. Aktive Rollen auswählen</CardTitle>
                        <CardDescription className="text-base">Wähle die Rollen aus, für die du Prompts erstellen lassen möchtest.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {AVAILABLE_ROLES.map(role => {
                            const isSelected = activeRoles.includes(role);
                            return (
                              <div key={role} className={`flex items-start space-x-3 p-4 border rounded-lg transition-colors cursor-pointer hover:bg-muted/50 ${isSelected ? 'bg-primary/5 border-primary/20 shadow-sm' : 'bg-card'}`}>
                                <Checkbox
                                  id={`role-select-${role}`}
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    if (checked) {
                                      setActiveRoles(prev => [...prev, role]);
                                    } else {
                                      setActiveRoles(prev => prev.filter(r => r !== role));
                                    }
                                  }}
                                  className="mt-0.5 w-5 h-5"
                                />
                                <div className="space-y-1">
                                  <label
                                    htmlFor={`role-select-${role}`}
                                    className="text-base font-semibold leading-none cursor-pointer"
                                  >
                                    {role.includes('(') ? role.split('(')[0].trim() : role}
                                  </label>
                                  {role.includes('(') && (
                                    <p className="text-xs text-muted-foreground line-clamp-1">
                                      {role.split('(')[1].replace(')', '')}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>

                    {activeRoles.length > 0 && (
                      <Card className="border-primary/10 shadow-md">
                        <CardHeader className="bg-muted/20 border-b">
                          <CardTitle className="text-2xl">2. Variablen & Eigenschaften je Rolle anpassen</CardTitle>
                          <CardDescription className="text-base">Konfiguriere hier die demografischen und spezifischen Parameter (Kommagetrennt) individuell für jede ausgewählte Rolle.</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-6">
                          <Tabs defaultValue={activeRoles[0]} className="w-full">
                            <TabsList className="mb-8 w-full flex flex-wrap justify-start h-auto bg-transparent gap-3 p-0">
                              {activeRoles.map(role => (
                                <TabsTrigger
                                  key={role}
                                  value={role}
                                  className="border bg-card data-[state=active]:bg-[#006f45] data-[state=active]:text-white py-2 px-6 h-auto min-h-[44px] text-sm font-medium transition-colors"
                                >
                                  {role.includes('(') ? role.split('(')[0].trim() : role}
                                </TabsTrigger>
                              ))}
                            </TabsList>

                            {activeRoles.map(role => {
                              const roleVars = roleVariables[role] || {};
                              return (
                                <TabsContent key={role} value={role} className="space-y-6 animate-in fade-in">
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6 bg-card">
                                    {variables.filter(v => v !== 'Rolle' && v !== 'Avatar_Eigenschaften_und_Praeferenzen').map(v => {
                                      const isFixed = ['Alter', 'Haushalt', 'Berufserfahrung', 'Wohnsitzland', 'Postleitzahl', 'Nationalitaet'].includes(v);
                                      return (
                                        <div key={v} className="space-y-3">
                                          <Label className="text-base font-semibold text-foreground/80">{v}</Label>
                                          <Input
                                            value={roleVars[v] || ''}
                                            onChange={(e) => updateRoleVariable(role, v, e.target.value)}
                                            placeholder="Option 1, Option 2, Option 3..."
                                            className={`text-base py-5 ${isFixed ? 'bg-muted border-muted/50 text-muted-foreground cursor-not-allowed font-medium' : 'bg-muted/20'}`}
                                            disabled={isFixed}
                                            readOnly={isFixed}
                                          />
                                        </div>
                                      );
                                    })}

                                    <div className="space-y-3 md:col-span-2 pt-2">
                                      <Label className="text-base font-semibold text-foreground/80 flex items-center gap-2">
                                        Avatar-Eigenschaften und Präferenzen
                                        <Info className="w-4 h-4 text-muted-foreground" />
                                      </Label>
                                      <Textarea
                                        value={roleVars['Avatar_Eigenschaften_und_Praeferenzen'] || ''}
                                        onChange={(e) => updateRoleVariable(role, 'Avatar_Eigenschaften_und_Praeferenzen', e.target.value)}
                                        placeholder="Z.b: Mind. 3 Jahre Arbeitserfahrung..."
                                        className="text-sm py-4 bg-muted/20 min-h-[140px] resize-y"
                                      />
                                      <p className="text-xs text-muted-foreground">Nutze dies für exakt definierte Eigenschaften, die fest zu dieser Persona gehören.</p>
                                    </div>
                                  </div>
                                </TabsContent>
                              );
                            })}
                          </Tabs>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="models" className="w-full animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="space-y-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h2 className="text-2xl font-bold">Modelle für diesen Lauf</h2>
                        <p className="text-muted-foreground">Wähle die KI-Modelle aus, die du gegeneinander antreten lassen willst. Stelle die Parameter gezielt ein.</p>
                      </div>
                      <div className="flex gap-2">
                        <Button onClick={() => addModelConfig('publicai')} variant="outline" className="gap-2 bg-blue-50/50 hover:bg-blue-100/50 border-blue-200">
                          <PlusCircle className="w-4 h-4 text-blue-600" />
                          Public AI Modell
                        </Button>
                        <Button onClick={() => addModelConfig('openrouter')} variant="outline" className="gap-2">
                          <PlusCircle className="w-4 h-4" />
                          OpenRouter Modell
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {configuredModels.map((model, idx) => (
                        <Card key={(model as any).id || idx} className="relative shadow-sm border-primary/20">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-2 top-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => removeModelConfig(idx)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                          <CardHeader className="pb-4">
                            <div className="flex items-center gap-2">
                              <Badge variant={model.type === 'publicai' ? 'default' : 'secondary'} className="text-[10px] uppercase">
                                {model.type}
                              </Badge>
                            </div>
                            <CardTitle className="text-lg mt-2">
                              {model.type === 'publicai' ? '🇨🇭 Swiss AI / Apertus' : 'OpenRouter Model'}
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-4">
                            <div className="space-y-2">
                              <Label className="text-xs uppercase font-semibold text-muted-foreground">Modell-ID</Label>
                              {model.type === 'openrouter' ? (
                                <Select value={model.modelId} onValueChange={(val) => updateModelConfig(idx, 'modelId', val)}>
                                  <SelectTrigger className="w-full bg-card">
                                    <SelectValue placeholder="Modell auswählen..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="openai/gpt-4o-mini">openai/gpt-4o-mini</SelectItem>
                                    {model.modelId !== 'openai/gpt-4o-mini' && (
                                      <SelectItem value={model.modelId}>{model.modelId}</SelectItem>
                                    )}
                                  </SelectContent>
                                </Select>
                              ) : model.type === 'publicai' ? (
                                <Select value={model.modelId} onValueChange={(val) => updateModelConfig(idx, 'modelId', val)}>
                                  <SelectTrigger className="w-full bg-card border-blue-200">
                                    <SelectValue placeholder="Modell auswählen..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="swiss-ai/apertus-70b-instruct">swiss-ai/apertus-70b-instruct</SelectItem>
                                    <SelectItem value="swiss-ai/apertus-8b-instruct">swiss-ai/apertus-8b-instruct</SelectItem>
                                    {model.modelId !== 'swiss-ai/apertus-70b-instruct' && model.modelId !== 'swiss-ai/apertus-8b-instruct' && (
                                      <SelectItem value={model.modelId}>{model.modelId}</SelectItem>
                                    )}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <Input value={model.modelId} onChange={(e) => updateModelConfig(idx, 'modelId', e.target.value)} />
                              )}
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <Label className="text-xs uppercase font-semibold text-muted-foreground">Temperature</Label>
                                <Input type="number" step="0.1" min="0" max="2" value={model.temperature ?? ''} onChange={(e) => updateModelConfig(idx, 'temperature', parseFloat(e.target.value))} />
                              </div>
                              <div className="space-y-2">
                                <Label className="text-xs uppercase font-semibold text-muted-foreground">Top-P</Label>
                                <Input type="number" step="0.05" min="0" max="1" value={model.top_p ?? ''} onChange={(e) => updateModelConfig(idx, 'top_p', parseFloat(e.target.value))} />
                              </div>
                              <div className="space-y-2 col-span-2">
                                <Label className="text-xs uppercase font-semibold text-muted-foreground">Max Output Tokens</Label>
                                <Input type="number" step="1" value={model.max_tokens ?? ''} onChange={(e) => updateModelConfig(idx, 'max_tokens', parseInt(e.target.value))} />
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}

                      {configuredModels.length === 0 && (
                        <div className="col-span-full text-center p-12 border-2 border-dashed rounded-xl bg-muted/10 text-muted-foreground">
                          Keine Modelle konfiguriert. Bitte erstelle mindestens ein Modell, um den Fragebogen auszuwerten.
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="generate" className="w-full animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <div className="space-y-6">
                    <Card className="border-primary/20 bg-primary/5">
                      <CardHeader className="text-center pb-4">
                        <CardTitle className="text-2xl">Bereit zum Generieren?</CardTitle>
                        <CardDescription className="text-base">
                          Du generierst mit {currentModelsCount} Modellen.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col items-center gap-6">
                        <div className="text-lg text-primary font-medium flex items-center justify-center gap-4 bg-background px-6 py-4 rounded-xl shadow-sm border">
                          <span className="text-3xl font-bold">{comboCount}</span> Kombinationen <span className="opacity-50">×</span> <span className="text-3xl font-bold">{currentModelsCount}</span> Modelle <span className="opacity-50">=</span> <span className="text-3xl font-bold underline decoration-primary/30 tracking-tight">{comboCount * currentModelsCount}</span> Prompts
                        </div>

                        <Button
                          onClick={handleRunAndSwitch}
                          disabled={variables.length === 0 || currentModelsCount === 0 || isGenerating}
                          size="lg"
                          className="w-full max-w-md text-lg h-14"
                        >
                          {isGenerating ? "Generieren läuft..." : "Generierung starten & Dashboard öffnen"}
                        </Button>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>Generierte Prompts – Vorschau</CardTitle>
                        <CardDescription>Die ersten 50 Prompt-Varianten (Zusammengebaut) als Stichprobe.</CardDescription>
                      </CardHeader>
                      <CardContent className="p-0 border-t">
                        <div className="max-h-[600px] overflow-auto">
                          <Table>
                            <TableHeader className="bg-muted/50 sticky top-0 z-10 shadow-sm">
                              <TableRow>
                                <TableHead className="w-[60px] text-center font-bold">#</TableHead>
                                <TableHead className="font-bold">Prompt (Vorschau)</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {generateCombinations().slice(0, 50).map((combo, idx) => {
                                let finalPrompt = metaPrompt;
                                variables.forEach(v => {
                                  finalPrompt = finalPrompt.replaceAll(`{{${v}}}`, combo[v] || '');
                                });
                                finalPrompt = finalPrompt.replaceAll(`{{Fragebogen}}`, fragebogen || '');

                                return (
                                  <TableRow key={idx}>
                                    <TableCell className="text-center font-mono text-muted-foreground">{idx + 1}</TableCell>
                                    <TableCell className="font-mono text-xs whitespace-pre-wrap leading-relaxed py-4">{finalPrompt}</TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>
              </Tabs>

              {Object.keys(aggData.stats).length > 0 && (
                <div className="text-center mt-12 pb-12">
                  <Button variant="secondary" onClick={() => setActiveTab('dashboard')} className="gap-2">
                    <LayoutDashboard className="w-4 h-4" />
                    Letzte Ergebnisse im Dashboard ansehen
                  </Button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'historie' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-16">
              <div className="flex items-center justify-between pb-4">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight">Historie</h2>
                  <p className="text-muted-foreground">Alle bisherigen Läufe aus der Supabase Datenbank.</p>
                </div>
                <Button variant="outline" onClick={fetchHistory}>Neu Laden</Button>
              </div>

              <div className="grid gap-4">
                {historicRuns.map(run => {
                  const usedRoles: string[] = run.active_roles || [];
                  const usedVars = run.role_variables || {};

                  return (
                    <Card key={run.id}>
                      <CardHeader>
                        <CardTitle>{run.name}</CardTitle>
                        <CardDescription>
                          Gestartet am: {new Date(run.created_at).toLocaleString('de-CH')}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-6 text-sm">
                          {run.models && run.models.length > 0 && (
                            <div className="space-y-2">
                              <div className="font-semibold mb-1">Verwendete Modelle:</div>
                              <div className="flex flex-wrap gap-2">
                                {run.models.map((modelId: string) => (
                                  <Badge variant="outline" key={modelId} className="font-medium text-[11px] border-primary/20 text-primary bg-primary/5">
                                    {modelId}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {usedRoles.length > 0 ? (
                            <div className="space-y-2">
                              <div className="font-semibold mb-1">Aktive Rollen:</div>
                              {usedRoles.map(role => {
                                const roleVars = usedVars[role] || {};
                                const simpleRole = role.includes('(') ? role.split('(')[0].trim() : role;
                                const activeConfig = Object.entries(roleVars).filter(([k, v]) => v && v.toString().trim() !== '' && k !== 'Rolle');
                                return (
                                  <div key={role} className="p-3 bg-muted/30 border rounded-md">
                                    <div className="font-semibold mb-2">{simpleRole}</div>
                                    <div className="flex flex-wrap gap-2">
                                      {activeConfig.length > 0 ? activeConfig.map(([k, v]) => (
                                        <Badge variant="secondary" key={k} className="text-xs font-normal border-primary/20">
                                          <span className="font-medium mr-1">{k}:</span>
                                          <span className="text-muted-foreground">{String(v)}</span>
                                        </Badge>
                                      )) : (
                                        <span className="text-muted-foreground text-xs italic">Keine Variablen definiert</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-muted-foreground italic">Rollendaten für diesen alten Tabellenlauf nicht gespeichert. Lade ihn, um die Details zu sehen.</div>
                          )}
                        </div>
                      </CardContent>
                      <CardFooter>
                        <Button
                          onClick={() => loadHistoricRun(run.id)}
                          disabled={isGenerating}
                        >
                          Diesen Lauf für Auswertung laden
                        </Button>
                      </CardFooter>
                    </Card>
                  );
                })}
                {historicRuns.length === 0 && (
                  <p className="text-muted-foreground">Noch keine Läufe vorhanden.</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'manual' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-16">
              <div className="flex items-center justify-between pb-4">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight">Demoscope-Datensatz</h2>
                  <p className="text-muted-foreground max-w-3xl">
                    Lade alle Screenshots auf einmal hoch. Die Vision-API erkennt die Rolle automatisch, extrahiert das Profil und alle Antworten und legt jede Persona als virtuelles Modell <span className="font-mono">{demoscope.modelName}</span> in deine Auswertung — gleiche Logik wie Apertus / gpt-4o-mini.
                  </p>
                </div>
              </div>

              {(() => {
                const pp = Math.max(1, demoscope.pagesPerPersona);
                const usingGroups = !!(demoscope.imageGroups && demoscope.imageGroups.length > 0);
                const expectedPersonas = usingGroups
                  ? demoscope.imageGroups!.length
                  : Math.ceil(demoscope.images.length / pp);
                const hasImages = demoscope.images.length > 0;
                const isExtracting = demoscope.status === 'extracting';
                const successN = demoscope.results.filter(r => r.status === 'success').length;
                const errorN = demoscope.results.filter(r => r.status === 'error').length;
                const loadingN = demoscope.results.filter(r => r.status === 'loading').length;
                const pendingN = demoscope.results.filter(r => r.status === 'pending').length;
                const totalProgress = successN + errorN;
                const totalToProcess = demoscope.results.length;
                // Pro Bild auf seine Gruppe (Persona) abbilden, damit das Preview-Label stimmt.
                const imageGroupIndex: number[] = [];
                const imageIndexInGroup: number[] = [];
                if (usingGroups) {
                  demoscope.imageGroups!.forEach((g, gi) => {
                    g.forEach((_, ii) => {
                      imageGroupIndex.push(gi);
                      imageIndexInGroup.push(ii);
                    });
                  });
                }

                return (
                  <Card className="border-primary/20 shadow-sm">
                    <CardHeader className="border-b bg-muted/5">
                      <CardTitle className="text-xl flex items-center gap-2"><Database className="w-5 h-5" /> Upload &amp; Stapel-Auswertung</CardTitle>
                      <CardDescription>
                        Zwei Upload-Wege: <span className="font-semibold">(1) Ordner hochladen</span> — wähle den <span className="font-mono">Profile/</span>-Ordner, jeder Persona-Unterordner wird automatisch als eine Persona gruppiert. <span className="font-semibold">(2) Einzeldateien</span> — flache Mehrfach-Auswahl, gechunked nach <span className="font-mono">Seiten pro Persona</span>.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-6 space-y-6">
                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-2">
                          <Label className="text-sm font-semibold">Name (modelId im Dashboard)</Label>
                          <Input
                            value={demoscope.modelName}
                            onChange={(e) => handleDemoscopeModelNameChange(e.target.value)}
                            placeholder="Demoscope"
                            disabled={isExtracting}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-sm font-semibold">Seiten pro Persona</Label>
                          <Input
                            type="number"
                            min={1}
                            value={demoscope.pagesPerPersona}
                            onChange={(e) => handleDemoscopePagesChange(parseInt(e.target.value) || 1)}
                            disabled={isExtracting || usingGroups}
                          />
                          <p className="text-xs text-muted-foreground">
                            {usingGroups
                              ? 'Wird ignoriert: Gruppierung kommt aus den Persona-Ordnern.'
                              : 'Wie viele Screenshots gehören zu EINER Persona (z. B. 3 bei 3-seitigem Fragebogen).'}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-sm font-semibold">Erkannte Personas</Label>
                          <div className="h-10 flex items-center px-3 rounded-md border bg-muted/30 font-mono text-sm">
                            {usingGroups ? (
                              <>{demoscope.images.length} Bilder in <span className="font-bold text-primary ml-1">{expectedPersonas}</span> Persona-Ordnern</>
                            ) : (
                              <>{demoscope.images.length} Bilder ÷ {pp} = <span className="font-bold text-primary ml-1">{expectedPersonas}</span> Personas</>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">Soll-Wert für die zweite Welle: 24.</p>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="border-2 border-dashed border-primary/40 rounded-lg p-6 bg-primary/5 hover:bg-primary/10 transition-colors">
                          <label className="flex flex-col items-center justify-center cursor-pointer text-center gap-2">
                            <Database className="w-8 h-8 text-primary" />
                            <span className="text-sm font-semibold">Ordner hochladen (empfohlen)</span>
                            <span className="text-xs text-muted-foreground">Wähle den <span className="font-mono">Profile/</span>-Ordner — jeder Unterordner = 1 Persona</span>
                            <input
                              type="file"
                              multiple
                              accept="image/*"
                              className="hidden"
                              onChange={handleDemoscopeAddFolder}
                              disabled={isExtracting}
                              {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                            />
                          </label>
                        </div>
                        <div className="border-2 border-dashed rounded-lg p-6 bg-muted/10 hover:bg-muted/20 transition-colors">
                          <label className="flex flex-col items-center justify-center cursor-pointer text-center gap-2">
                            <Upload className="w-8 h-8 text-muted-foreground" />
                            <span className="text-sm font-medium">Einzeldateien</span>
                            <span className="text-xs text-muted-foreground">Flache Mehrfach-Auswahl, gechunked nach <span className="font-mono">Seiten pro Persona</span></span>
                            <input type="file" multiple accept="image/*" className="hidden" onChange={handleDemoscopeAddImages} disabled={isExtracting} />
                          </label>
                        </div>
                      </div>

                      {hasImages && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Label className="text-sm font-semibold">Hochgeladene Bilder ({demoscope.images.length})</Label>
                            <Button variant="ghost" size="sm" className="text-destructive" onClick={handleDemoscopeReset} disabled={isExtracting}>
                              <Trash2 className="w-3 h-3 mr-1" /> Alle entfernen
                            </Button>
                          </div>
                          <div className="grid grid-cols-6 md:grid-cols-10 gap-2 max-h-64 overflow-y-auto p-2 border rounded-md bg-background">
                            {demoscope.images.map((imgUrl, i) => {
                              const gi = usingGroups ? imageGroupIndex[i] : Math.floor(i / pp);
                              const ii = usingGroups ? imageIndexInGroup[i] : i % pp;
                              const folderLabel = usingGroups ? demoscope.groupLabels?.[gi] : undefined;
                              return (
                                <div key={i} className="relative aspect-square rounded-md overflow-hidden border shadow-sm group">
                                  <img src={imgUrl} className="w-full h-full object-cover" alt={`Screenshot ${i + 1}`} />
                                  <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[10px] px-1 py-0.5 font-mono text-center truncate" title={folderLabel || `Persona ${gi + 1}`}>
                                    {folderLabel ? `${folderLabel.slice(0, 14)}…` : `P${gi + 1}`} · {ii + 1}
                                  </div>
                                  {!isExtracting && (
                                    <button className="absolute right-1 top-1 bg-black/60 hover:bg-destructive rounded-full p-0.5 text-white opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => handleDemoscopeRemoveImage(i)} title="Entfernen">
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-2 border-t">
                        <div className="text-sm text-muted-foreground">
                          {!hasImages && <>Lade Screenshots hoch, um zu starten.</>}
                          {hasImages && demoscope.status === 'idle' && <>Bereit für Stapel-Auswertung von <span className="font-bold text-foreground">{expectedPersonas}</span> Personas.</>}
                          {isExtracting && <>Verarbeite {totalProgress + loadingN}/{totalToProcess} ({successN} ✓, {errorN} ✗, {loadingN + pendingN} offen)</>}
                          {demoscope.status === 'done' && <>Fertig: <span className="text-green-600 font-bold">{successN}</span> erfolgreich, <span className="text-red-600 font-bold">{errorN}</span> Fehler — bereits im Dashboard sichtbar.</>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            onClick={() => runDemoscopeExtraction({ limit: 1 })}
                            disabled={!hasImages || isExtracting || !apiKey}
                            size="lg"
                            className="gap-2"
                            title="Nur die erste Persona auswerten — sinnvoll als Kostentest, bevor alle 24 laufen."
                          >
                            <FlaskConical className="w-4 h-4" /> Nur 1 Persona testen
                          </Button>
                          <Button onClick={() => runDemoscopeExtraction()} disabled={!hasImages || isExtracting || !apiKey} size="lg" className="gap-2">
                            {isExtracting ? <>Extrahiere {totalProgress + 1}/{totalToProcess}...</> : <><FlaskConical className="w-4 h-4" /> Alle auswerten</>}
                          </Button>
                        </div>
                      </div>

                      {!apiKey && (
                        <div className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-md p-3">
                          Hinweis: Es ist kein OpenRouter-API-Key konfiguriert. Bitte unter Settings eintragen — die Vision-Extraktion läuft über GPT-4o.
                        </div>
                      )}

                      {demoscope.results.length > 0 && (
                        <div className="space-y-3 pt-4">
                          <Label className="text-sm font-semibold">Extraktions-Status pro Persona</Label>
                          <div className="overflow-x-auto rounded-md border max-h-96 overflow-y-auto">
                            <Table>
                              <TableHeader className="bg-muted/40 sticky top-0">
                                <TableRow>
                                  <TableHead className="w-[60px] font-semibold text-center">#</TableHead>
                                  <TableHead className="w-[110px] font-semibold">Status</TableHead>
                                  <TableHead className="w-[200px] font-semibold">Erkannte Rolle</TableHead>
                                  <TableHead className="font-semibold">Profil-Highlights</TableHead>
                                  <TableHead className="w-[100px] text-center font-semibold">Antworten</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {demoscope.results.map((r, idx) => {
                                  const answersN = r.status === 'success' ? Object.keys(parseAnswers(r.response)).length : 0;
                                  const profileChips = Object.entries(r.combo).filter(([k, v]) => k !== 'Rolle' && v).slice(0, 4);
                                  return (
                                    <TableRow key={r.id}>
                                      <TableCell className="text-center font-mono text-muted-foreground">{idx + 1}</TableCell>
                                      <TableCell>
                                        <Badge variant={r.status === 'success' ? 'default' : r.status === 'error' ? 'destructive' : 'secondary'} className="text-[10px] w-20 justify-center">
                                          {r.status}
                                        </Badge>
                                      </TableCell>
                                      <TableCell className="font-medium">
                                        {r.combo.Rolle || '—'}
                                      </TableCell>
                                      <TableCell>
                                        <div className="flex flex-wrap gap-1">
                                          {profileChips.map(([k, v]) => (
                                            <span key={k} className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono text-muted-foreground" title={k}>
                                              {String(v)}
                                            </span>
                                          ))}
                                          {r.error && <span className="text-xs text-destructive">{r.error}</span>}
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-center tabular-nums text-muted-foreground">
                                        {answersN > 0 ? answersN : '—'}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })()}
            </div>
          )}

          {activeTab === 'dashboard' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-16">

              <div className="flex items-start justify-between pb-4">
                <div className="flex flex-col gap-3">
                  <div>
                    <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
                    <p className="text-muted-foreground">Analytics und Ergebnisse deines Fragebogens (Live-Export jederzeit möglich)</p>
                  </div>
                  
                  {/* Historic run selector and Offline toggle */}
                  <div className="flex flex-wrap items-center gap-6 mt-1 p-2 bg-secondary/30 rounded-lg border border-border/50">
                    <div className="flex items-center gap-2">
                      <History className="w-4 h-4 text-muted-foreground" />
                      <Label htmlFor="run-selector" className="font-semibold text-sm">Lauf wählen:</Label>
                      <Select value={activeRunId ? activeRunId.toString() : 'current'} onValueChange={(v) => {
                        if (v === 'current') {
                          setActiveRunId(null);
                          setResults([]);
                        } else {
                          loadHistoricRun(parseInt(v));
                        }
                      }}>
                        <SelectTrigger id="run-selector" className="w-[280px] h-8 bg-background">
                          <SelectValue placeholder="Aktueller Lauf" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="current" className="font-semibold">Aktueller Lauf (ungespeichert)</SelectItem>
                          {historicRuns.length > 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">Gespeicherte Läufe</div>}
                          {historicRuns.map(run => (
                            <SelectItem key={run.id} value={run.id.toString()}>
                              {run.name} <span className="text-muted-foreground text-xs ml-2">({new Date(run.created_at).toLocaleDateString()})</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {activeRunId && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setActiveRunId(null)} title="Zum aktuellen Lauf zurückkehren">
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>

                    <div className="h-4 w-px bg-border hidden sm:block"></div>

                    <div className="flex items-center space-x-2 bg-background px-3 py-1 rounded-md border shadow-sm">
                      <Checkbox 
                        id="offline-toggle" 
                        checked={includeOfflineData}
                        onCheckedChange={(c) => setIncludeOfflineData(!!c)} 
                      />
                      <Label 
                        htmlFor="offline-toggle" 
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                      >
                        Offline-Datensatz {includeOfflineData ? 'einbeziehen' : 'ausschließen'}
                      </Label>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">

                  <Button variant="default" className="gap-2" onClick={downloadExcel} disabled={filteredResultsAll.length === 0 || isGenerating}>
                    <Download className="w-4 h-4" />
                    Export
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-3xl font-bold">{results.length}</CardTitle>
                    <CardDescription>Generierte Prompts</CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-3xl font-bold">{Object.keys(aggData.stats).length > 0 ? Object.keys(aggData.stats).length : getModelsToRun().length}</CardTitle>
                    <CardDescription>Verwendete Modelle</CardDescription>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-3xl font-bold">{results.filter(r => r.status === 'success').length}</CardTitle>
                    <CardDescription>Erfolgreiche Antworten</CardDescription>
                  </CardHeader>
                </Card>
              </div>

              {Object.keys(getModelSuccessRates()).length > 0 && (
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-xl">Erfolgsquote pro Modell</CardTitle>
                    <CardDescription>
                      Apertus &amp; Co. melden gelegentlich 504/Gateway-Fehler. Diese Karte zeigt transparent, wie viele Personas pro Modell tatsächlich geantwortet haben — Grundlage für Reflexionsteil &amp; Aggregat-Interpretation.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="font-semibold">Modell</TableHead>
                            <TableHead className="text-center font-semibold">Erfolgsquote</TableHead>
                            <TableHead className="text-center font-semibold">Erfolg</TableHead>
                            <TableHead className="text-center font-semibold">Fehler</TableHead>
                            <TableHead className="text-center font-semibold">Pending / Loading</TableHead>
                            <TableHead className="font-semibold">Beispiel-Fehlertext</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {Object.entries(getModelSuccessRates()).map(([modelId, t]) => {
                            const total = t.success + t.error + t.pending + t.loading;
                            const pct = total === 0 ? 0 : (t.success / total) * 100;
                            const pctColor = pct >= 100 ? 'text-green-600' : pct >= 90 ? 'text-amber-600' : 'text-red-600';
                            return (
                              <TableRow key={modelId} className="hover:bg-muted/50 transition-colors">
                                <TableCell>
                                  <Badge variant="outline" className="font-medium text-[10px] border-primary/20 text-primary bg-primary/5">{modelId}</Badge>
                                </TableCell>
                                <TableCell className={`text-center font-semibold tabular-nums ${pctColor}`}>
                                  {pct.toFixed(1)}% ({t.success}/{total})
                                </TableCell>
                                <TableCell className="text-center tabular-nums text-green-600">{t.success}</TableCell>
                                <TableCell className="text-center tabular-nums text-red-600">{t.error}</TableCell>
                                <TableCell className="text-center tabular-nums text-muted-foreground">{t.pending + t.loading}</TableCell>
                                <TableCell className="text-xs text-muted-foreground max-w-[280px] truncate" title={t.errors.join(' | ')}>
                                  {t.errors[0] || '—'}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card className="shadow-sm border-primary/20 bg-card">
                <CardHeader className="md:flex-row md:items-center justify-between gap-4 py-4">
                  <div>
                    <CardTitle className="text-xl">📊 Dashboard Ansicht & Filter</CardTitle>
                  </div>
                  <div className="w-full md:w-[400px]">
                    <Select value={dashboardRoleFilter} onValueChange={setDashboardRoleFilter}>
                      <SelectTrigger className="w-full bg-background border-primary/20">
                        <SelectValue placeholder="Rollen-Filter" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Alle">-- Alle Rollen kombiniert (Durchschnitt) --</SelectItem>
                        {Array.from(new Set(results.map(r => r.combo['Rolle'] ? (r.combo['Rolle'].includes('(') ? r.combo['Rolle'].split('(')[0].trim() : r.combo['Rolle']) : 'Keine Rolle'))).filter(Boolean).map(role => (
                          <SelectItem key={role!} value={role!}>{role}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardHeader>
              </Card>

              {Object.keys(aggData.stats).length > 0 ? (
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-xl">Modell-Vergleich (1-7) für: <span className="text-primary">{dashboardRoleFilter}</span> <span className="text-muted-foreground ml-2 text-sm font-normal">(n = {currentFilterN} Datenpunkte)</span></CardTitle>
                    <CardDescription>Performance der Modelle anhand der extrahierten Likert-Skalen aus den erfolgreichen Antworten.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[450px] w-full pt-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 50 }}>
                          <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
                          <XAxis dataKey="name" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} angle={-25} textAnchor="end" />
                          <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} domain={[1, 7]} ticks={[1, 2, 3, 4, 5, 6, 7]} />
                          <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} cursor={{ fill: 'transparent' }} />
                          <Legend wrapperStyle={{ paddingTop: '20px' }} />
                          {modelColors.map(mc => (
                            <Bar key={mc.model} dataKey={mc.model} fill={mc.color} radius={[4, 4, 0, 0]} maxBarSize={60} />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="text-center p-12 text-muted-foreground border border-dashed rounded-lg bg-muted/20 mt-4">
                  Noch keine Daten verfügbar. Starte den Generator, um Charts zu sehen.
                </div>
              )}

              {tableData.rows.length > 0 && (
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle>Tabellarische Übersicht (Einzel-Profile)</CardTitle>
                    <CardDescription>Daten-Matrix der Likert-Werte aufgeschlüsselt nach Rolle, Profil-Variablen und Modell. Format pro Zelle: <span className="font-mono">Mean (σ, n)</span>. Hohe σ = differenzierende Antworten, σ ≈ 0 = LLM antwortet uniform.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="w-[150px] font-semibold">Rolle</TableHead>
                            <TableHead className="w-[200px] font-semibold">Profil</TableHead>
                            <TableHead className="w-[150px] font-semibold">Modell</TableHead>
                            {tableData.columns.map(col => (
                              <TableHead key={col} className="text-center whitespace-nowrap font-semibold px-4">{col}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tableData.rows.sort((a, b) => a.role.localeCompare(b.role) || a.modelId.localeCompare(b.modelId)).map((row, idx) => (
                            <TableRow key={idx} className="hover:bg-muted/50 transition-colors">
                              <TableCell className="font-medium align-middle">{row.role}</TableCell>
                              <TableCell className="align-middle text-xs text-muted-foreground">{row.profile || '-'}</TableCell>
                              <TableCell className="align-middle">
                                <Badge variant="outline" className="font-medium text-[10px] border-primary/20 text-primary bg-primary/5">{row.modelId}</Badge>
                              </TableCell>
                              {tableData.columns.map(col => {
                                const val = row[col];
                                const sigma = row[`${col}_sigma`];
                                const n = row[`${col}_n`];
                                const numVal = Number(val);
                                const isNum = val && !isNaN(numVal) && String(val).trim() !== '';
                                return (
                                  <TableCell key={col} className="text-center align-middle px-4 max-w-[200px] truncate" title={String(val)}>
                                    {val ? (
                                      isNum ? (
                                        <span className="tabular-nums">
                                          <span className={numVal >= 4 ? 'text-green-600 font-medium' : 'text-orange-600 font-medium'}>{val}</span>
                                          {sigma !== undefined && (
                                            <span className="text-[10px] text-muted-foreground ml-1">(σ={sigma}, n={n ?? '?'})</span>
                                          )}
                                        </span>
                                      ) : (
                                        <span className="text-sm">{val}</span>
                                      )
                                    ) : '-'}
                                  </TableCell>
                                );
                              })}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {filteredResultsAll.length > 0 && (
                <Card className="shadow-sm">
                  <CardHeader>
                    <CardTitle className="text-xl">Einzelansicht (Rohdaten)</CardTitle>
                    <CardDescription>Jeder einzelne ausgeführte Prompt als detaillierte Zeile (zeigt alle {filteredResultsAll.length} Prompts im Filter, davon n={currentFilterN} erfolgreich). Diese Ansicht entspricht auch der ersten Seite deines Excel-Exports!</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-md border max-h-[600px] overflow-y-auto bg-card">
                      <Table>
                        <TableHeader className="bg-muted/50 sticky top-0 z-10 shadow-sm">
                          <TableRow>
                            <TableHead className="w-[80px] font-semibold text-center">ID</TableHead>
                            <TableHead className="w-[100px] font-semibold">Status</TableHead>
                            <TableHead className="w-[140px] font-semibold">Modell</TableHead>
                            <TableHead className="w-[200px] font-semibold">Rolle</TableHead>
                            <TableHead className="font-semibold">Kombination & Log-Antwort</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredResultsAll.map((r, idx) => {
                            const simpleRole = r.combo['Rolle'] ? (r.combo['Rolle'].includes('(') ? r.combo['Rolle'].split('(')[0].trim() : r.combo['Rolle']) : '-';
                            return (
                              <TableRow key={idx} className="hover:bg-muted/50 transition-colors group">
                                <TableCell className="font-mono text-muted-foreground text-center tabular-nums">{r.id}</TableCell>
                                <TableCell>
                                  <Badge variant={r.status === 'success' ? 'default' : r.status === 'error' ? 'destructive' : 'secondary'} className="text-[10px] w-20 justify-center">
                                    {r.status}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="font-medium text-[10px] border-primary/20 text-primary bg-primary/5">{r.modelId}</Badge>
                                </TableCell>
                                <TableCell className="font-medium align-top pt-4">{simpleRole}</TableCell>
                                <TableCell className="align-top">
                                  {r.status === 'loading' ? (
                                    <div className="flex items-center space-x-2 text-muted-foreground animate-pulse mt-1">
                                      <div className="h-4 w-4 rounded-full bg-current"></div>
                                      <span className="text-sm">
                                        {r.modelConfig?.type === 'local' 
                                          ? 'Lädt/Generiert (Erst-Download d. Modells kann dauern)...' 
                                          : 'Lädt/Generiert Antwort (API request)...'}
                                      </span>
                                    </div>
                                  ) : (
                                    <div className="flex flex-col gap-3 py-1">
                                      {/* Tags for Variables */}
                                      <div className="flex gap-1.5 flex-wrap">
                                        {Object.entries(r.combo).filter(([k]) => k !== 'Rolle').map(([k, v]) => (
                                          <span key={k} className="bg-zinc-100 dark:bg-zinc-900 border px-1.5 py-0.5 rounded shadow-sm text-zinc-600 dark:text-zinc-400 font-mono text-[10px]">
                                            {String(v)}
                                          </span>
                                        ))}
                                      </div>

                                      {/* Extracted Likert Scores */}
                                      {r.status === 'success' && (
                                        <div className="flex gap-2 flex-wrap">
                                          {Object.entries(parseAnswers(r.response)).map(([f, s]) => {
                                            const numS = Number(s);
                                            const isNum = !isNaN(numS) && String(s).trim() !== '';
                                            return (
                                              <span key={f} className="text-xs bg-secondary text-secondary-foreground font-semibold px-2 py-0.5 rounded shadow-sm border max-w-xs truncate" title={String(s)}>
                                                {f}: <span className={isNum ? (numS >= 4 ? 'text-green-600' : 'text-orange-600') : 'text-primary'}>{s}</span>{isNum ? '/7' : ''}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      )}

                                      {/* Raw Answer Block */}
                                      {r.response && (
                                        <div className="bg-zinc-50 dark:bg-zinc-900/50 p-3 rounded-md border text-zinc-800 dark:text-zinc-200 font-mono text-xs whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed shadow-inner">
                                          {r.response}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              )}

            </div>
          )
          }
        </div >
      </main >
    </div >
  );
}
