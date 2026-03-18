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
        let sc = b.score ?? b.Score ?? b.bewertung ?? b.Bewertung ?? b.wert ?? b.antwort ?? b.Antwort;
        if (fn !== undefined && sc !== undefined) {
          const frageNum = String(fn).replace(/[^\d]/g, '');
          if (frageNum) {
            const scStr = String(sc).trim();
            const scMatch = scStr.match(/^([1-7])$/);
            if (scMatch) {
              bestScores[`F${frageNum}`] = Number(scMatch[1]);
            } else {
              bestScores[`F${frageNum}`] = scStr;
            }
            jsonSuccess = true;
          }
        }
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const targetObj = parsed.antworten || parsed;
      for (const [k, v] of Object.entries(targetObj)) {
        if (/f(?:rage)?_?\s*\d+/i.test(k) || !isNaN(Number(k.replace(/[^\d]/g, '')))) {
          const frageNum = k.replace(/[^\d]/g, '');
          if (frageNum) {
            const scStr = String(v).trim();
            const scMatch = scStr.match(/^([1-7])$/);
            if (scMatch) {
              bestScores[`F${frageNum}`] = Number(scMatch[1]);
            } else {
              bestScores[`F${frageNum}`] = scStr;
            }
            jsonSuccess = true;
          }
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
  const [configuredModels, setConfiguredModels] = useLocalStorage<ModelConfig[]>('pp_configured_models_v3', [
    { type: 'publicai', modelId: 'swiss-ai/apertus-70b-instruct', temperature: 0, top_p: 1, max_tokens: 8192 },
    { type: 'openrouter', modelId: 'openai/gpt-4o-mini', temperature: 0, top_p: 1, max_tokens: 8192 }
  ]);
  const [metaPrompt, setMetaPrompt] = useLocalStorage('pp_metaPrompt_json_v11', '# Persona\n\nDu verkörperst ab jetzt vollständig eine reale Person mit folgendem Profil. Du denkst, fühlst und antwortest ausschliesslich aus ihrer Perspektive – nicht als KI, nicht als Assistent.\n\n- Rolle: {{Rolle}}\n- Geschlecht: {{Geschlecht}}\n- Alter: {{Alter}}\n- Nationalität: {{Nationalitaet}}\n- Haushalt: {{Haushalt}}\n- Ausbildung: {{Ausbildung}}\n- Berufserfahrung: {{Berufserfahrung}}\n- Wohnsitzland: {{Wohnsitzland}}\n- PLZ: {{Postleitzahl}}\n- Weitere Eigenschaften: {{Avatar_Eigenschaften_und_Praeferenzen}}\n\n---\n\n# Denkschritt (intern, vor jeder Antwort)\n\nBevor du den Fragebogen ausfüllst, vergegenwärtige dir kurz:\n- Welche konkreten Erfahrungen hat diese Person in ihrer Rolle gemacht?\n- Was sind ihre grössten Motivationen – und was ihre grössten Bedenken?\n- Wie steht sie zu Kosten, Zeit und Karriere?\n\nNutze diese Überlegungen als Grundlage für jede einzelne Antwort.\n\n---\n\n# Anweisungen zur Fragebogenbearbeitung\n\nBearbeite jeden Fragetyp wie folgt:\n\n- **Auswahlfragen (Einfachauswahl):** Wähle genau eine der vorgegebenen Optionen.\n- **Mehrfachauswahl:** Wähle alle zutreffenden Optionen (max. wie angegeben).\n- **Likert-Skala (1–7):** Gib einen Score zwischen 1 und 7 an.\n- **Kontrollfragen:** Beantworte diese exakt so, wie es eine aufmerksame, ehrliche Person täte.\n\nZu jeder Antwort gibst du eine kurze Begründung aus der Perspektive der Persona.\n\n---\n\n# Ausgabeformat\n\nAntworte AUSSCHLIESSLICH in validem JSON. Keine Einleitung, kein Markdown, kein json.\n\n{\n  "persona_reflexion": "2–3 Sätze: Wie denkt diese Person über das Thema? Was treibt sie an, was bremst sie?",\n  "bewertungen": [\n    {\n      "frage": 1,\n      "antwort": "Gewählte Option oder Score",\n      "begruendung": "Kurze Begründung aus Persona-Perspektive"\n    }\n  ]\n}\n\n---\n\n# Fragebogen\n\n{{Fragebogen}}\n\n---\n\nDeine JSON-Antwort:');
  const [fragebogen, setFragebogen] = useLocalStorage('pp_fragebogen_v5', `SEKTION B - Weiterbildungsmotivation
F4. Was ist Ihr primäres Motiv für eine CAS-Weiterbildung im Bereich Marketing, Digital & Communication? Karriereaufstieg / Wissen vertiefen / Quereinstieg / Formalen Abschluss erlangen / Netzwerk aufbauen / Praxisprobleme lösen
F5. KONTROLLFRAGE (Aufmerksamkeitscheck) Um sicherzustellen, dass Sie die Fragen sorgfältig lesen – wählen Sie bitte ausschliesslich die Option «Netzwerk / Community». Karriereperspektiven / Inhalte / Netzwerk / Community / Kosten / Marke der Institution
F6. «Ich würde eine Weiterbildung auch dann absolvieren, wenn mein Arbeitgeber die Kosten nicht übernimmt.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F7. Welche Themen sind für Sie am relevantesten? (bis zu 3 auswählen) KI & Automatisierung / Data Analytics / Content Strategy / Social Media / SEO/SEA / Brand Management / Customer Experience / Integrierte Kommunikation

SEKTION C - Format-Präferenzen
F8. Welches Lernformat bevorzugen Sie für eine berufsbegleitende Weiterbildung? Vollständig online asynchron / Online synchron / Hybrid / Vollständig Präsenz
F9. An welchen Tagen wären Präsenzmodule für Sie günstig? (Mehrfachauswahl) Mo / Di / Mi / Do / Fr / Sa / Kein Präsenztag möglich
F10. Wie viel Zeit können Sie realistisch pro Woche investieren? Bis 3 Std. / 4-6 Std. / 7-10 Std. / Mehr als 10 Std.

SEKTION D - Relevanz CAS-Inhalte
F11. Wie relevant ist für Sie: «Strategische Markenführung und Positionierung»? (1: Gar nicht relevant - 7: Äusserst relevant)
F12. Wie relevant ist für Sie: «Einsatz von KI-Tools im Marketing-Alltag»? (1: Gar nicht relevant - 7: Äusserst relevant)
F13. KONTROLLFRAGE (Konsistenzcheck zu F6) Angenommen, Sie müssen eine Weiterbildung vollständig selbst finanzieren – wie beeinflusst das Ihre Entscheidung? Definitiv verzichten / Eher verzichten / Unentschlossen / Wahrscheinlich trotzdem / Definitiv trotzdem
F14. Wie relevant ist für Sie: «Datenanalyse und Marketing-Reporting»? (1: Gar nicht relevant - 7: Äusserst relevant)

SEKTION E - Entscheidungsfaktoren
F15. Was ist der wichtigste Faktor bei der Wahl eines CAS-Programms? Reputation der Institution / Curriculum-Qualität / Praxisrelevanz / Formatflexibilität / Kosten / Netzwerkpotenzial
F16. Welchen maximalen Gesamtbetrag empfinden Sie für einen CAS als gerechtfertigt? Bis CHF 3'000 / 3'001-6'000 / 6'001-9'000 / 9'001-12'000 / Mehr als 12'000
F17. «Ein direkter Praxistransfer in meinen Arbeitsalltag ist für mich ein entscheidendes Kriterium bei der Programmwahl.» (1: Trifft überhaupt nicht zu - 7: Trifft vollständig zu)
F18. Haben Sie in den letzten 3 Jahren aktiv nach CAS-Weiterbildungen im Bereich Marketing/Digital/Kommunikation gesucht? Ja, konkret evaluiert / Ja, grob recherchiert / Nein, aber geplant / Nein, kein Bedarf
F20. KONTROLLFRAGE (Selbstauskunft / Straight-liner-Check) Wie haben Sie diesen Fragebogen ausgefüllt? Jede Frage sorgfältig gelesen und ehrlich beantwortet / Die meisten gelesen, einige überflogen / Viele Fragen nur oberflächlich beantwortet / Den Fragebogen hauptsächlich schnell durchgeklickt`);

  const roleEigenschaften: Record<string, string> = {
    'CEM (Customer Experience Manager)': `Branchenwissen: Customer Experience, Customer Service, Marketing / Customer Relations
Tools & Technologien: Microsoft Office / Shopify, Microsoft PowerPoint / Marketing Automation (HubSpot/Klaviyo), Microsoft Excel / Google Ads / Google Marketing Suite
Soziale Kompetenz: Teamwork / Structured working style, Leadership / Teamwork / Collaboration, Customer Service / Organizational skills
Weitere Kenntnisse: Project Management / Customer Journey / UX, Event Management / Campaign Management, Analytical Skills / Präsentationsskills`,

    'SMM (Social Media Manager)': `Branchenwissen: Digital Marketing, Marketing, E-Commerce
Tools & Technologien: Microsoft Office / Analytics & BI (Tableau/Looker/Power BI), Google Analytics / CMS (WordPress/Typo3/other), Microsoft Excel / Google Ads / Google Marketing Suite
Soziale Kompetenz: Teamwork / Teamwork / Collaboration, Communication / Analytical thinking, Project Management / Proactive / autonomous working style
Weitere Kenntnisse: Project Management / Campaign Management, Online Marketing / KPI / Analytics & Reporting, Social Media / Performance Marketing`,

    'DMM (Digital Manager)': `Branchenwissen: Social Media Marketing / Content Creation, Digital Marketing / Kommunikation, Social Media / Partnerschaften
Tools & Technologien: Microsoft Office / Adobe Creative Suite, Microsoft PowerPoint / Social Media Platforms (FB/TikTok/IG), Microsoft Word / CMS / Typo3
Soziale Kompetenz: Teamwork / Teamwork / Collaboration, Leadership / Structured working style, Communication / Proactive / autonomous
Weitere Kenntnisse: Social Media / Social Media Strategy, Sales / Content Strategy & Planning, Project Management / Video & Photo Production`,

    'Growth Manager': `Branchenwissen: Digital Marketing / Website Development, SEO / Digital Marketing, Web Design / Website security
Tools & Technologien: WordPress / CMS (WordPress/Typo3/other), HTML / HTML / CSS, Google Analytics / Dev tools (Git/Docker/CI/CD)
Soziale Kompetenz: Teamwork / Teamwork / Collaboration, Communication / Technical leadership, Project Management / Cross-functional collaboration
Weitere Kenntnisse: Social Media / Technical Architecture / DevOps, SEO / Website Operations / Content Publishing, Marketing Strategy / Customer Journey / UX`,

    'Kommunikation Manager': `Branchenwissen: Event Management / Kommunikation, Digital Marketing / Strategische Kommunikationsplanung, Corporate Communications / Stakeholderkommunikation
Tools & Technologien: Microsoft Office / MS 365 / Content Management Systems, Adobe InDesign / Social Media / Monitoring tools, Adobe Photoshop / Digitale Kanäle / Content Formate
Soziale Kompetenz: Teamwork / Communication, Social Media / Teamwork / Collaboration, Communication / Strategic thinking
Weitere Kenntnisse: Project Management / Strategic Communications, Marketing Strategy / Project Management, SEO / Leadership`,

    'Webseiten Manager': `Branchenwissen: Marketing / Digital Media and publishing, Customer Service / Fintec, Blockchain, stablecoin, FMCG / AI Governance and Compliance
Tools & Technologien: Microsoft Office / Google Analytics / GA4, Microsoft Excel / Meta Ads / Google Ads, Microsoft PowerPoint / Marketing Automation platforms
Soziale Kompetenz: Leadership / Data-driven mindset, Teamwork / Strategic thinking, Communication / Cross-functional collaboration
Weitere Kenntnisse: Project Management / Funnel Optimization / A/B Testing, Marketing Strategy / Campaign Management, Campaign Management / Performance Marketing`
  };

  const defaultRoleVars = AVAILABLE_ROLES.reduce((acc, role) => {
    acc[role] = {
      Geschlecht: 'Männlich, Weiblich',
      Alter: '30',
      Nationalitaet: 'Schweiz',
      Haushalt: '2 Personen 1 Kind',
      Ausbildung: 'Master, Bachelor',
      Berufserfahrung: '3 Jahre',
      Wohnsitzland: 'Schweiz',
      Postleitzahl: '9000',
      Avatar_Eigenschaften_und_Praeferenzen: roleEigenschaften[role] || ''
    };
    return acc;
  }, {} as Record<string, Record<string, string>>);

  const [activeRoles, setActiveRoles] = useLocalStorage<string[]>('pp_active_roles_v6', AVAILABLE_ROLES);
  const [roleVariables, setRoleVariables] = useLocalStorage<Record<string, Record<string, string>>>('pp_role_vars_v17', defaultRoleVars);

  const variables = PROFILE_VARIABLES;
  const [results, setResults] = useState<{ id: string; promptSent: string; response: string; status: 'pending' | 'loading' | 'success' | 'error'; combo: Record<string, string>; modelId: string; modelConfig?: ModelConfig }[]>([]);
  const [historicRuns, setHistoricRuns] = useState<any[]>([]);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  type OfflineBatchItem = {
    id: string;
    images: string[];
    status: 'idle' | 'loading' | 'success' | 'error';
    result?: string;
  };

  type OfflineBatch = {
    id: string;
    modelName: string;
    targetRunIds: number[];
    items: OfflineBatchItem[];
  };

  const [offlineBatches, setOfflineBatches] = useLocalStorage<OfflineBatch[]>('pp_offline_batches_v1', []);
  const [selectedRunsForSync, setSelectedRunsForSync] = useState<Record<string, string>>({});
  const [includeOfflineData, setIncludeOfflineData] = useLocalStorage('pp_include_offline_data', true);

  const handleAddBatch = () => {
    setOfflineBatches(prev => [...prev, { id: Date.now().toString(), modelName: 'Demoscope', targetRunIds: [], items: [] }]);
  };

  const handleRemoveBatch = (id: string) => {
    setOfflineBatches(prev => prev.filter(b => b.id !== id));
  };

  const handleSyncBatchToRun = async (batchId: string, runId: number) => {
    const batch = offlineBatches.find(b => b.id === batchId);
    if (!batch) return;

    await supabase.from('prompt_run_results').delete().eq('run_id', runId).eq('model_id', batch.modelName || 'Manuelles Modell');

    const successfulItems = batch.items.filter(i => i.status === 'success' && i.result);
    for (const item of successfulItems) {
      let extractedData: any;
      try {
        let jsonString = item.result!;
        const match = item.result!.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) jsonString = match[1];
        extractedData = JSON.parse(jsonString);
      } catch (e) { continue; }

      const combo: Record<string, string> = {
        Rolle: extractedData.profil?.Rolle || 'Unbekannt',
      };
      variables.forEach(v => {
        if (v !== 'Rolle') combo[v] = extractedData.profil?.[v] || '';
      });

      const newResult = {
        run_id: runId,
        model_id: batch.modelName || 'Manuelles Modell',
        combo: combo,
        prompt_sent: 'Manuell extrahiert aus Screenshots',
        response: JSON.stringify(extractedData),
        status: 'success'
      };

      await supabase.from('prompt_run_results').insert(newResult).then(({ error }) => { if (error) console.error("Error saving manual result to run " + runId, error); });
    }

    setOfflineBatches(prev => prev.map(b => b.id === batchId ? {
      ...b,
      targetRunIds: Array.from(new Set([...(b.targetRunIds || []), runId]))
    } : b));

    alert(`Extrahierten Datensatz in Tresor-Lauf gespeichert!`);

    if (activeRunId === runId) {
      loadHistoricRun(runId);
    }
  };

  const handleRemoveBatchFromRun = async (batchId: string, runId: number) => {
    const batch = offlineBatches.find(b => b.id === batchId);
    if (!batch) return;

    await supabase.from('prompt_run_results').delete().eq('run_id', runId).eq('model_id', batch.modelName || 'Manuelles Modell');
    setOfflineBatches(prev => prev.map(b => b.id === batchId ? {
      ...b,
      targetRunIds: (b.targetRunIds || []).filter(id => id !== runId)
    } : b));

    alert(`Datensatz aus Tresor-Lauf entfernt!`);

    if (activeRunId === runId) {
      loadHistoricRun(runId);
    }
  };

  const handleAddBatchItem = (batchId: string) => {
    setOfflineBatches(prev => prev.map(b => b.id === batchId ? { ...b, items: [...b.items, { id: Date.now().toString() + Math.random(), images: [], status: 'idle' }] } : b));
  };

  const handleRemoveBatchItem = (batchId: string, itemId: string) => {
    setOfflineBatches(prev => prev.map(b => b.id === batchId ? { ...b, items: b.items.filter(i => i.id !== itemId) } : b));
  };

  const handleImageUpload = async (batchId: string, itemId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const base64Promises = files.map(file => {
      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          resolve(event.target?.result as string);
        };
        reader.readAsDataURL(file);
      });
    });

    const base64Images = await Promise.all(base64Promises);

    setOfflineBatches(prev => prev.map(b => {
      if (b.id === batchId) {
        return {
          ...b,
          items: b.items.map(i => i.id === itemId ? { ...i, images: [...i.images, ...base64Images] } : i)
        };
      }
      return b;
    }));
  };



  const removeImageFromItem = (batchId: string, itemId: string, imageIndex: number) => {
    setOfflineBatches(prev => prev.map(b => {
      if (b.id === batchId) {
        return {
          ...b,
          items: b.items.map(i => i.id === itemId ? { ...i, images: i.images.filter((_, idx) => idx !== imageIndex) } : i)
        };
      }
      return b;
    }));
  };

  const handleExtractBatchItem = async (batchId: string, itemId: string) => {
    if (!apiKey) {
      alert('Bitte API Key (OpenRouter) in den Settings eintragen, um die Vision API (z.B. GPT-4o) zu nutzen.');
      return;
    }
    const batch = offlineBatches.find(b => b.id === batchId);
    if (!batch) return;
    const item = batch.items.find(i => i.id === itemId);
    if (!item || item.images.length === 0) return;

    setOfflineBatches(prev => prev.map(b => b.id === batchId ? {
      ...b, items: b.items.map(i => i.id === itemId ? { ...i, status: 'loading' } : i)
    } : b));

    try {
      const res = await extractFromImages(item.images, apiKey, fragebogen);
      setOfflineBatches(prev => prev.map(b => b.id === batchId ? {
        ...b, items: b.items.map(i => i.id === itemId ? { ...i, status: 'success', result: res } : i)
      } : b));

      let extractedData: any;
      try {
        let jsonString = res;
        const match = res.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) jsonString = match[1];
        extractedData = JSON.parse(jsonString);
      } catch (e) {
        throw new Error("Konnte Antwort nicht als JSON parsen: " + res);
      }

      const combo: Record<string, string> = {
        Rolle: extractedData.profil?.Rolle || 'Unbekannt',
        ...extractedData.profil
      };
      // fallback in case variables state had some other names missing
      variables.forEach(v => {
        if (v !== 'Rolle' && !combo[v]) combo[v] = extractedData.profil?.[v] || '';
      });

      let mockResponse = JSON.stringify(extractedData);

      const newResult = {
        id: `manuell-${Date.now()}-${Math.random()}`,
        promptSent: 'Manuell extrahiert aus Screenshots',
        response: mockResponse,
        status: 'success' as const,
        combo: combo,
        modelId: batch.modelName || 'Manuelles Modell',
        modelConfig: { type: 'openrouter', modelId: batch.modelName || 'openai/gpt-4o' }
      };

    } catch (err: any) {
      setOfflineBatches(prev => prev.map(b => b.id === batchId ? {
        ...b, items: b.items.map(i => i.id === itemId ? { ...i, status: 'error', result: err.message } : i)
      } : b));
    }
  };

  const getOfflineTableData = (batchId: string) => {
    const batch = offlineBatches.find(b => b.id === batchId);
    if (!batch) return { rows: [], columns: [] };

    const rows: any[] = [];
    const allFragen = new Set<string>();

    batch.items.filter(i => i.status === 'success' && i.result).forEach(item => {
      try {
        let match = item.result!.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        let jsonStr = match ? match[1] : item.result!;
        const parsed = JSON.parse(jsonStr);
        let comboInfo = "Unbekannt";
        
        if (parsed.profil) {
          comboInfo = parsed.profil.Rolle || Object.values(parsed.profil).filter(Boolean).join(', ');
        }

        const ans = parsed.antworten || parseAnswers(item.result!);

        const rowData: any = { Rolle: comboInfo };
        Object.entries(ans).forEach(([frage, score]) => {
          allFragen.add(frage);
          rowData[frage] = score;
        });
        rows.push(rowData);
      } catch (e) {
        // Fallback robust parsing if JSON is broken completely
        try {
          const scores = parseAnswers(item.result!);
          const rowData: any = { Rolle: "Unbekannt" };
          Object.entries(scores).forEach(([frage, score]) => {
            allFragen.add(frage);
            rowData[frage] = score;
          });
          rows.push(rowData);
        } catch(e2) {}
      }
    });

    const columns = Array.from(allFragen).sort((a, b) => parseInt(a.replace(/\D/g, '') || '0') - parseInt(b.replace(/\D/g, '') || '0'));
    return { rows, columns };
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

  const offlineResults: any[] = offlineBatches.flatMap(batch => 
    (batch.items || []).filter(i => i.status === 'success' && i.result).map(item => {
      let combo: Record<string, string> = { Rolle: 'Unbekannt' };
      try {
        let match = item.result!.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        let jsonStr = match ? match[1] : item.result!;
        const parsed = JSON.parse(jsonStr);
        if (parsed.profil) {
          combo = { ...parsed.profil, Rolle: parsed.profil.Rolle || 'Unbekannt' };
        }
      } catch (e) {}
      
      return {
        id: `offline-${batch.id}-${item.id}`,
        promptSent: 'Offline Upload: ' + (batch.modelName || 'Datensatz'),
        response: item.result,
        status: 'success' as const,
        combo: combo,
        modelId: batch.modelName || 'Manuelles Modell',
        modelConfig: { type: 'openrouter', modelId: 'offline' }
      };
    })
  );

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

      // Find all unique questions across all responses to ensure consistent column ordering
      const allFragen = new Set<string>();
      filteredResultsAll.forEach(r => {
        const scores = parseAnswers(r.response);
        Object.keys(scores).forEach(f => allFragen.add(f));
      });
      const sortQuestions = (a: string, b: string) => {
        const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
        const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
        return numA - numB;
      };
      const sortedFragen = Array.from(allFragen).sort(sortQuestions);

      // Sheet 1: Raw Data
      const rawData = filteredResultsAll.map(r => {
        const rowItem: any = {
          ID: r.id,
          Status: r.status,
          Model: r.modelId,
        };
        variables.forEach(v => {
          rowItem[v] = r.combo[v] || '';
        });

        // Parse scores and map them to their specific columns
        const scores = parseAnswers(r.response);
        sortedFragen.forEach(f => {
          rowItem[f] = scores[f] !== undefined ? scores[f] : '';
        });

        rowItem['Prompt Sent'] = r.promptSent;
        rowItem['Response'] = r.response;
        return rowItem;
      });
      const ws1 = XLSX.utils.json_to_sheet(rawData);
      XLSX.utils.book_append_sheet(wb, ws1, "1_Einzelansicht");

      // Sheet 2: Aggregated Metrics
      const tableData = getTableData();
      if (tableData.rows.length > 0) {
        const aggRows = tableData.rows.map(row => {
          const rowItem: any = {
            Rolle: row.role,
            Profil: row.profile,
            Modell: row.modelId
          };
          tableData.columns.forEach(col => {
            const val = row[col];
            rowItem[col] = val !== undefined ? Number(val) : null;
          });
          return rowItem;
        });
        const ws2 = XLSX.utils.json_to_sheet(aggRows);
        XLSX.utils.book_append_sheet(wb, ws2, "2_Tabellarische_Uebersicht");
      }

      // Sheet 3: Graph Data (Easy Charting in Excel)
      const aggData = getAggregatedData();
      if (aggData.fragen.length > 0) {
        const chartData = aggData.fragen.map(frage => {
          const dataPoint: any = { 'Frage / Metrik': frage };
          Object.keys(aggData.stats).forEach(modelId => {
            const stat = aggData.stats[modelId][frage];
            dataPoint[modelId] = stat ? Number((stat.sum / stat.count).toFixed(2)) : null;
          });
          return dataPoint;
        });
        const ws3 = XLSX.utils.json_to_sheet(chartData);
        XLSX.utils.book_append_sheet(wb, ws3, "3_Graphik");
      }

      // Sheet 4: Durchschnitte per Rolle & Modell
      const averagesData = getAveragesTableData();
      if (averagesData.rows.length > 0) {
        const avgRows = averagesData.rows.map(row => {
          const rowItem: any = {
            Rolle: row.role,
            Modell: row.modelId
          };
          averagesData.columns.forEach(col => {
            const val = row[col];
            rowItem[col] = val !== undefined ? Number(val) : null;
          });
          return rowItem;
        });
        const ws4 = XLSX.utils.json_to_sheet(avgRows);
        XLSX.utils.book_append_sheet(wb, ws4, "4_Durchschnitte_Modelle");
      }

      XLSX.writeFile(wb, `prompt_results_${Date.now()}.xlsx`);
    } catch (err: any) {
      console.error(err);
      alert("Fehler beim Excel-Export: " + err.message);
    }
  };

  const getAggregatedData = () => {
    const groupStats: Record<string, { [frage: string]: { sum: number, count: number } }> = {};
    const allFragen = new Set<string>();

    filteredResultsValid.forEach(r => {
      const scores = parseAnswers(r.response);

      // We always group by model inside the chart, so we can compare the models exactly!
      const groupKey = r.modelId;

      if (!groupStats[groupKey]) groupStats[groupKey] = {};
      Object.entries(scores).forEach(([frage, score]) => {
        const numScore = Number(score);
        if (isNaN(numScore)) return; // Skip non-numeric values for the bar chart calculation

        allFragen.add(frage);
        if (!groupStats[groupKey][frage]) groupStats[groupKey][frage] = { sum: 0, count: 0 };
        groupStats[groupKey][frage].sum += numScore;
        groupStats[groupKey][frage].count += 1;
      });
    });

    const sortQuestions = (a: string, b: string) => {
      const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
      const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
      return numA - numB;
    };

    return {
      stats: groupStats,
      fragen: Array.from(allFragen).sort(sortQuestions)
    };
  };

  const getTableData = () => {
    const tableRows: any[] = [];
    const allFragenForTable = new Set<string>();
    const grouped: any = {};

    filteredResultsValid.forEach(r => {
      const scores = parseAnswers(r.response);
      const roleName = r.combo['Rolle'] || 'Keine Rolle';
      const simplifyRole = roleName.includes('(') ? roleName.split('(')[0].trim() : roleName;
      const modelId = r.modelId;

      const profileKeys = Object.entries(r.combo)
        .filter(([k]) => k !== 'Rolle')
        .map(([k, v]) => v)
        .filter(Boolean)
        .join(', ');

      const key = `${r.id}_${simplifyRole}_${modelId}`;

      if (!grouped[key]) {
        grouped[key] = { role: simplifyRole, profile: profileKeys, modelId: modelId, scores: {}, counts: {} };
      }

      Object.entries(scores).forEach(([frage, score]) => {
        const numScore = Number(score);
        if (isNaN(numScore)) return; // Skip text answers for averages

        allFragenForTable.add(frage);
        if (!grouped[key].scores[frage]) {
          grouped[key].scores[frage] = 0;
          grouped[key].counts[frage] = 0;
        }
        grouped[key].scores[frage] += numScore;
        grouped[key].counts[frage] += 1;
      });
    });

    Object.values(grouped).forEach((g: any) => {
      const finalRow: any = { role: g.role, profile: g.profile, modelId: g.modelId };
      Object.entries(g.scores).forEach(([frage, sum]: [string, any]) => {
        finalRow[frage] = (sum / g.counts[frage]).toFixed(2);
      });
      tableRows.push(finalRow);
    });

    const sortQuestions = (a: string, b: string) => {
      const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
      const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
      return numA - numB;
    };

    return { rows: tableRows, columns: Array.from(allFragenForTable).sort(sortQuestions) };
  };

  const getAveragesTableData = () => {
    const tableRows: any[] = [];
    const allFragenForTable = new Set<string>();
    const grouped: any = {};

    filteredResultsValid.forEach(r => {
      const scores = parseAnswers(r.response);
      const roleName = r.combo['Rolle'] || 'Keine Rolle';
      const simplifyRole = roleName.includes('(') ? roleName.split('(')[0].trim() : roleName;
      const modelId = r.modelId;

      const key = `${simplifyRole}_${modelId}`;

      if (!grouped[key]) {
        grouped[key] = { role: simplifyRole, modelId: modelId, scores: {}, counts: {} };
      }

    Object.entries(scores).forEach(([frage, score]) => {
        const numScore = Number(score);
        if (isNaN(numScore)) return; // Skip text answers for averages

        allFragenForTable.add(frage);
        if (!grouped[key].scores[frage]) {
          grouped[key].scores[frage] = 0;
          grouped[key].counts[frage] = 0;
        }
        grouped[key].scores[frage] += numScore;
        grouped[key].counts[frage] += 1;
      });
    });

    Object.values(grouped).forEach((g: any) => {
      const finalRow: any = { role: g.role, modelId: g.modelId };
      Object.entries(g.scores).forEach(([frage, sum]: [string, any]) => {
        finalRow[frage] = (sum / g.counts[frage]).toFixed(2);
      });
      tableRows.push(finalRow);
    });

    const sortQuestions = (a: string, b: string) => {
      const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
      const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
      return numA - numB;
    };

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
            <Database className="w-4 h-4" /> Offline Datensatz
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
                  <h2 className="text-3xl font-bold tracking-tight">Offline Datensatz</h2>
                  <p className="text-muted-foreground">Lade Screenshots reeller Umfragen oder Testdaten hoch (z.B. Demoscope). Ein GPT-4 Vision Modell extrahiert die Profil-Variablen und Antworten und verknüpft sie optional mit deinen Läufen.</p>
                </div>
                <Button onClick={handleAddBatch} className="gap-2"><Plus className="w-4 h-4" /> Neuen Datensatz hinzufügen</Button>
              </div>

              {offlineBatches.length === 0 ? (
                <div className="text-center p-12 text-muted-foreground border border-dashed rounded-lg bg-muted/20">
                  Keine Datensätze vorhanden. Klicke auf &quot;Neuen Datensatz hinzufügen&quot;, um Screenshots hochzuladen.
                </div>
              ) : (
                <div className="space-y-12">
                  {offlineBatches.map((batch, idx) => {
                    const tableData = getOfflineTableData(batch.id);
                    return (
                      <Card key={batch.id} className="border-primary/20 shadow-sm relative pt-4 overflow-hidden">
                        <Button variant="ghost" size="icon" className="absolute right-4 top-4 text-destructive hover:bg-destructive/10 z-10" onClick={() => handleRemoveBatch(batch.id)}><Trash2 className="w-4 h-4" /></Button>

                        <div className="px-6 pb-2 grid grid-cols-1 md:grid-cols-2 gap-6 relative z-0">
                          <div className="space-y-3">
                            <Label className="text-base font-semibold">Name / Quelle des Datensatzes</Label>
                            <Input
                              value={batch.modelName}
                              onChange={(e) => setOfflineBatches(prev => prev.map(b => b.id === batch.id ? { ...b, modelName: e.target.value } : b))}
                              placeholder="z.B. Demoscope"
                              className="bg-muted/30 font-medium text-lg h-12"
                            />
                          </div>
                          <div className="space-y-3">
                            {/* Run management moved to bottom */}
                          </div>
                        </div>

                        <div className="px-6 py-4 border-t bg-muted/5 flex items-center justify-between">
                          <div>
                            <h3 className="font-semibold text-lg">Zugehörige Datensätze (Personas)</h3>
                            <p className="text-xs text-muted-foreground">Füge für jeden Datensatz (z.B. jede der 30 Personas) Bilder hinzu.</p>
                          </div>
                          <div className="flex flex-wrap gap-2 justify-end">

                            <Button onClick={() => handleAddBatchItem(batch.id)} size="sm" variant="outline" className="gap-2">
                              <PlusCircle className="w-4 h-4" /> Weiteren Datensatz hinzufügen
                            </Button>
                          </div>
                        </div>

                        <CardContent className="space-y-6 pt-4 bg-muted/5">
                          {batch.items.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground text-sm border-2 border-dashed rounded-lg border-muted-foreground/20">
                              Noch keine Datensätze angelegt.
                            </div>
                          ) : (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                              {batch.items.map((item, idxx) => (
                                <div key={item.id} className="relative group bg-background rounded-xl p-4 shadow-sm border">
                                  <Button variant="ghost" size="icon" className="absolute right-2 top-2 h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveBatchItem(batch.id, item.id)}>
                                    <X className="w-3 h-3" />
                                  </Button>
                                  <div className="text-sm font-semibold mb-3">Datensatz #{idxx + 1}</div>

                                  <div className="flex flex-wrap gap-2 mb-4">
                                    {item.images.map((imgUrl, i) => (
                                      <div key={i} className="relative w-16 h-16 rounded-md overflow-hidden border shadow-sm">
                                        <img src={imgUrl} className="w-full h-full object-cover" alt="Preview" />
                                        <button className="absolute inset-0 bg-black/60 opacity-0 hover:opacity-100 items-center justify-center flex text-white" onClick={() => removeImageFromItem(batch.id, item.id, i)}>
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </div>
                                    ))}
                                    {item.images.length < 10 && (
                                      <label className="w-16 h-16 flex flex-col items-center justify-center border border-dashed rounded-md cursor-pointer hover:bg-muted/50 text-muted-foreground">
                                        <Upload className="w-4 h-4 mb-1" />
                                        <input type="file" multiple accept="image/*" className="hidden" onChange={(e) => handleImageUpload(batch.id, item.id, e)} />
                                      </label>
                                    )}
                                  </div>

                                  <Button size="sm" className="w-full" disabled={item.images.length === 0 || item.status === 'loading'} onClick={() => handleExtractBatchItem(batch.id, item.id)}>
                                    {item.status === 'loading' ? 'Extrahiert...' : item.status === 'success' ? 'Erneut extrahieren' : 'Auswerten'}
                                  </Button>

                                  {item.status === 'success' && <Badge className="absolute bottom-2 right-2 bg-green-500 hover:bg-green-600">Erledigt</Badge>}
                                  {item.status === 'error' && <Badge variant="destructive" className="absolute bottom-2 right-2 max-w-[200px] truncate" title={item.result}>Fehler: {item.result}</Badge>}
                                </div>
                              ))}
                            </div>
                          )}

                          {tableData.rows.length > 0 && (
                            <div className="mt-8 pt-6 border-t">
                              <h3 className="font-semibold text-lg mb-4">Tabellarische Übersicht für {batch.modelName}</h3>
                              <div className="overflow-x-auto rounded-lg border bg-background">
                                <Table>
                                  <TableHeader className="bg-muted/30">
                                    <TableRow>
                                      <TableHead className="font-bold whitespace-nowrap">Extrahierte Rolle / Profil</TableHead>
                                      {tableData.columns.map(col => (
                                        <TableHead key={col} className="text-center font-bold whitespace-nowrap">{col}</TableHead>
                                      ))}
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {tableData.rows.map((row, r_idx) => (
                                      <TableRow key={r_idx}>
                                        <TableCell className="font-medium">{row.Rolle}</TableCell>
                                        {tableData.columns.map(col => (
                                          <TableCell key={col} className="text-center">{row[col] ?? '-'}</TableCell>
                                        ))}
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          )}

                          <div className="mt-8 pt-6 border-t">
                            <h3 className="font-semibold text-lg mb-4">Datensatz in Tresor-Lauf verwalten</h3>
                            <p className="text-sm text-muted-foreground mb-4">Wähle einen oder mehrere Läufe aus, in denen diese extrahierten Daten gespeichert werden sollen.</p>

                            <div className="rounded-lg border bg-background overflow-hidden">
                              <Table>
                                <TableHeader className="bg-muted/30">
                                  <TableRow>
                                    <TableHead className="font-semibold w-[60%]">Ziel-Lauf (Tresor)</TableHead>
                                    <TableHead className="font-semibold text-center w-[20%]">Status</TableHead>
                                    <TableHead className="text-right w-[20%]"></TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {historicRuns.length === 0 && (
                                    <TableRow>
                                      <TableCell colSpan={3} className="text-center text-muted-foreground py-6">Keine Läufe vorhanden</TableCell>
                                    </TableRow>
                                  )}
                                  {historicRuns.map(run => {
                                    const isAdded = batch.targetRunIds && batch.targetRunIds.includes(run.id);
                                    return (
                                      <TableRow key={run.id} className={isAdded ? "bg-primary/5" : ""}>
                                        <TableCell className="font-medium">
                                          {run.name} <span className="text-muted-foreground font-normal ml-2">({new Date(run.created_at).toLocaleDateString('de-CH')})</span>
                                        </TableCell>
                                        <TableCell className="text-center">
                                          {isAdded ? (
                                            <Badge className="bg-green-500 hover:bg-green-600">Hinzugefügt</Badge>
                                          ) : (
                                            <Badge variant="outline" className="text-muted-foreground border-muted-foreground/30">Nicht hinzugefügt</Badge>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {isAdded ? (
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              className="text-destructive hover:text-destructive hover:bg-destructive/10 z-10"
                                              onClick={() => handleRemoveBatchFromRun(batch.id, run.id)}
                                            >
                                              Wieder entfernen
                                            </Button>
                                          ) : (
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              className="border-primary text-primary hover:bg-primary/10 z-10"
                                              onClick={() => handleSyncBatchToRun(batch.id, run.id)}
                                              disabled={batch.items.filter(i => i.status === 'success' && i.result).length === 0}
                                            >
                                              Zu Lauf hinzufügen
                                            </Button>
                                          )}
                                        </TableCell>
                                      </TableRow>
                                    );
                                  })}
                                </TableBody>
                              </Table>
                            </div>
                          </div>

                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
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
                    <CardDescription>Daten-Matrix aller Likert-Werte aufgeschlüsselt nach Rolle, Profil-Variablen und Modell.</CardDescription>
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
                                const numVal = Number(val);
                                const isNum = val && !isNaN(numVal) && String(val).trim() !== '';
                                return (
                                  <TableCell key={col} className="text-center align-middle px-4 max-w-[200px] truncate" title={String(val)}>
                                    {val ? (
                                      isNum ? 
                                        <span className={numVal >= 4 ? 'text-green-600 font-medium tabular-nums' : 'text-orange-600 font-medium tabular-nums'}>{val}</span>
                                        : 
                                        <span className="text-sm">{val}</span>
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
