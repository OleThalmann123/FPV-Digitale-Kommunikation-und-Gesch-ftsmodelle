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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LayoutDashboard, FlaskConical, Download, Settings, Key, Info } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as XLSX from 'xlsx';

function parseLikertScores(responseText: string): Record<string, number> {
  const scores: Record<string, number> = {};

  // 0. Try to parse JSON output first
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Extract array from typical keys models might use
      const bewertungen = parsed.bewertungen || parsed.Bewertungen || parsed.results || parsed.fragen || (Array.isArray(parsed) ? parsed : []);
      if (Array.isArray(bewertungen)) {
        for (const b of bewertungen) {
          const fn = b.frage ?? b.Frage ?? b.id ?? b.question;
          const sc = b.score ?? b.Score ?? b.bewertung ?? b.Bewertung ?? b.wert;
          if (fn !== undefined && sc !== undefined) {
            const frageNum = String(fn).replace(/[^\d]/g, '');
            if (frageNum) {
              scores[`Frage ${frageNum}`] = Number(sc);
            }
          }
        }
        if (Object.keys(scores).length > 0) return scores;
      }
    }
  } catch (e) {
    // Silently fall through to regex if JSON parsing fails
  }

  // 1. JSON-like regex fallback (for broken JSON or unescaped characters breaking JSON.parse)
  // Looks for: "frage": 1 ... "score": 5
  let regex = /"frage"\s*:\s*(\d+)[^}]*?"score"\s*:\s*([1-7])/gi;
  let match;
  let hasMatches = false;

  while ((match = regex.exec(responseText)) !== null) {
    scores[`Frage ${match[1]}`] = parseInt(match[2], 10);
    hasMatches = true;
  }
  if (hasMatches) return scores;

  // 2. Strict regex trying to match structures like [Frage 1: 5], **Frage 1**: 5, [Frage 1] - 5
  regex = /\[?\*?\*?Frage\s*(\d+)\*?\*?\s*\]?[\s:=-]+\[?\*?\*?([1-7])\*?\*?\]?/gi;
  while ((match = regex.exec(responseText)) !== null) {
    scores[`Frage ${match[1]}`] = parseInt(match[2], 10);
    hasMatches = true;
  }
  if (hasMatches) return scores;

  // 3. Fallback: Just look for "Frage X" and pick the first 1-7 digit that follows shortly after
  regex = /Frage\s*(\d+)[^\d]{1,50}?([1-7])/gi;
  while ((match = regex.exec(responseText)) !== null) {
    scores[`Frage ${match[1]}`] = parseInt(match[2], 10);
  }

  return scores;
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
  const [activeTab, setActiveTab] = useState<'generator' | 'dashboard' | 'settings'>('generator');
  const [dashboardRoleFilter, setDashboardRoleFilter] = useState<string>('Alle');
  const [apiKey, setApiKey] = useLocalStorage('pp_apiKey', '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');
  const [modelList, setModelList] = useLocalStorage('pp_modelList', 'publicai:swiss-ai/apertus-70b-instruct\nopenai/gpt-4o-mini');
  const [metaPrompt, setMetaPrompt] = useLocalStorage('pp_metaPrompt_json_v6', 'Versetze dich in die Rolle einer Person mit exakt folgendem Profil:\n- Rolle: {{Rolle}}\n- Geschlecht: {{Geschlecht}}\n- Alter: {{Alter}}\n- Nationalität: {{Nationalitaet}}\n- Haushalt: {{Haushalt}}\n- Ausbildung: {{Ausbildung}}\n- Berufserfahrung: {{Berufserfahrung}}\n- Wohnsitzland: {{Wohnsitzland}}\n- PLZ: {{Postleitzahl}}\n- Besonderheiten: {{Avatar_Eigenschaften_und_Praeferenzen}}\n\nBitte bearbeite den untenstehenden Fragebogen strikt aus der Perspektive dieser Person.\nBewerte jede Frage/Aussage auf einer Likert-Skala von 1 bis 7 (1 = Stimme überhaupt nicht zu / Finde ich gar nicht gut, 7 = Stimme voll und ganz zu / Finde ich sehr gut).\n\nWICHTIG: Antworte ZWINGEND in einem validen JSON-Format. Nutze exakt dieses Format:\n{\n  "bewertungen": [\n    {\n      "frage": 1,\n      "score": 5,\n      "begruendung": "kurze Begründung"\n    },\n    {\n      "frage": 2,\n      "score": 3,\n      "begruendung": "..."\n    }\n  ]\n}\nGib niemals etwas anderes als das JSON aus!\n\nFragebogen:\n{{Fragebogen}}\n\nDeine JSON-Antwort:');
  const [fragebogen, setFragebogen] = useLocalStorage('pp_fragebogen', 'Frage 1: Wie gefällt dir die Idee einer App, die deine täglichen Einkäufe automatisch und basierend auf deinen Routinen an deine Haustür liefert?\nFrage 2: Welche Bedenken hättest du bei der Nutzung von KI-gestützter Finanzberatung für deine privaten Ersparnisse?\nFrage 3: Wenn dir dein Arbeitgeber ein rein virtuelles Büro im Metaverse als hybride Alternative zum Home-Office anbieten würde, wie wäre deine ehrliche Meinung dazu?');

  const defaultRoleVars = AVAILABLE_ROLES.reduce((acc, role) => {
    acc[role] = {
      Geschlecht: 'Männlich, Weiblich',
      Alter: '',
      Nationalitaet: 'Schweiz',
      Haushalt: 'Zwei Erwachsene mit Kindern, Single',
      Ausbildung: 'Master, Bachelor',
      Berufserfahrung: '3 Jahre',
      Wohnsitzland: 'Schweiz',
      Postleitzahl: '8704, 8000',
      Avatar_Eigenschaften_und_Praeferenzen: ''
    };
    return acc;
  }, {} as Record<string, Record<string, string>>);

  const [activeRoles, setActiveRoles] = useLocalStorage<string[]>('pp_active_roles_v6', AVAILABLE_ROLES);
  const [roleVariables, setRoleVariables] = useLocalStorage<Record<string, Record<string, string>>>('pp_role_vars_v6', defaultRoleVars);

  const variables = PROFILE_VARIABLES;
  const [results, setResults] = useState<{ id: string; promptSent: string; response: string; status: 'pending' | 'loading' | 'success' | 'error'; combo: Record<string, string>; modelId: string }[]>([]);

  useEffect(() => {
    setMounted(true);
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
        const split = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
        parsedOptions[v] = split.length > 0 ? split : [''];
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

  const getModelsToRun = (): ModelConfig[] => {
    return modelList.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        if (line.startsWith('local:')) {
          return { type: 'local', modelId: line.replace('local:', '').trim() };
        }
        if (line.startsWith('publicai:')) {
          return { type: 'publicai', modelId: line.replace('publicai:', '').trim() };
        }
        return { type: 'openrouter', modelId: line };
      });
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

    // Process each one
    for (let i = 0; i < newResults.length; i++) {
      const current = newResults[i];
      setResults(prev => prev.map(r => r.id === current.id ? { ...r, status: 'loading' } : r));

      try {
        const res = await processPrompt(current.promptSent, current.modelConfig, apiKey); // Assuming current.promptConfig is correct
        setResults(prev => prev.map(r => r.id === current.id ? { ...r, status: 'success', response: res } : r));
      } catch (err: any) {
        setResults(prev => prev.map(r => r.id === current.id ? { ...r, status: 'error', response: err.message || 'Error executing API' } : r));
      }
    }
    setIsGenerating(false);
  };

  const handleRunAndSwitch = async () => {
    runAll();
    setActiveTab('dashboard');
  };

  const currentModelsCount = getModelsToRun().length;
  const comboCount = generateCombinations().length;

  const filteredResultsAll = results.filter(r => {
    let roleName = r.combo['Rolle'] || 'Keine Rolle';
    if (roleName.includes('(')) roleName = roleName.split('(')[0].trim();
    if (dashboardRoleFilter !== 'Alle' && roleName !== dashboardRoleFilter) return false;
    return true;
  });

  const filteredResultsValid = filteredResultsAll.filter(r => r.status === 'success' && r.response);

  const downloadExcel = () => {
    if (filteredResultsAll.length === 0) return;

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
      rowItem['Prompt Sent'] = r.promptSent;
      rowItem['Response'] = r.response;
      return rowItem;
    });
    const ws1 = XLSX.utils.json_to_sheet(rawData);

    // Sheet 2: Aggregated Metrics
    const tableData = getTableData();
    const aggRows = tableData.rows.map(row => {
      const rowItem: any = {
        Rolle: row.role,
        Modell: row.modelId
      };
      tableData.columns.forEach(col => {
        const cell = row.scores[col];
        rowItem[col] = cell ? Number((cell.sum / cell.count).toFixed(2)) : null;
      });
      return rowItem;
    });
    const ws2 = XLSX.utils.json_to_sheet(aggRows);

    // Sheet 3: Graph Data (Easy Charting in Excel)
    const aggData = getAggregatedData();
    const chartData = aggData.fragen.map(frage => {
      const dataPoint: any = { 'Frage / Metrik': frage };
      Object.keys(aggData.stats).forEach(modelId => {
        const stat = aggData.stats[modelId][frage];
        dataPoint[modelId] = stat ? Number((stat.sum / stat.count).toFixed(2)) : null;
      });
      return dataPoint;
    });
    const ws3 = XLSX.utils.json_to_sheet(chartData);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "1_Einzelansicht");
    if (aggRows.length > 0) {
      XLSX.utils.book_append_sheet(wb, ws2, "2_Tabellarische_Uebersicht");
    }
    if (chartData.length > 0) {
      XLSX.utils.book_append_sheet(wb, ws3, "3_Graphik");
    }

    XLSX.writeFile(wb, `prompt_results_${Date.now()}.xlsx`);
  };

  const getAggregatedData = () => {
    const groupStats: Record<string, { [frage: string]: { sum: number, count: number } }> = {};
    const allFragen = new Set<string>();

    filteredResultsValid.forEach(r => {
      const scores = parseLikertScores(r.response);

      // We always group by model inside the chart, so we can compare the models exactly!
      const groupKey = r.modelId;

      if (!groupStats[groupKey]) groupStats[groupKey] = {};
      Object.entries(scores).forEach(([frage, score]) => {
        allFragen.add(frage);
        if (!groupStats[groupKey][frage]) groupStats[groupKey][frage] = { sum: 0, count: 0 };
        groupStats[groupKey][frage].sum += score;
        groupStats[groupKey][frage].count += 1;
      });
    });

    return {
      stats: groupStats,
      fragen: Array.from(allFragen).sort()
    };
  };

  const getTableData = () => {
    const tableRows: any[] = [];
    const allFragenForTable = new Set<string>();
    const grouped: any = {};

    filteredResultsValid.forEach(r => {
      const scores = parseLikertScores(r.response);
      const roleName = r.combo['Rolle'] || 'Keine Rolle';
      const simplifyRole = roleName.includes('(') ? roleName.split('(')[0].trim() : roleName;
      const modelId = r.modelId;

      const key = `${simplifyRole}_${modelId}`;

      if (!grouped[key]) {
        grouped[key] = { role: simplifyRole, modelId: modelId, scores: {}, counts: {} };
      }

      Object.entries(scores).forEach(([frage, score]) => {
        allFragenForTable.add(frage);
        if (!grouped[key].scores[frage]) {
          grouped[key].scores[frage] = 0;
          grouped[key].counts[frage] = 0;
        }
        grouped[key].scores[frage] += score;
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

    return { rows: tableRows, columns: Array.from(allFragenForTable).sort() };
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
          <h1 className="text-xl font-serif font-bold tracking-tight text-primary">Prompt Platform</h1>
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
            variant={activeTab === 'dashboard' ? 'secondary' : 'ghost'}
            className="justify-start gap-3 w-full"
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard className="w-4 h-4" /> Auswertung
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
                  <div className="space-y-2">
                    <Label htmlFor="apiKey">Globaler API Key (OpenRouter / PublicAI)</Label>
                    <Input
                      id="apiKey"
                      type="password"
                      placeholder="sk-or-v1-..."
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Aktive Modelle (Eins pro Zeile)</Label>
                    <Textarea
                      className="min-h-[120px] font-mono whitespace-pre-wrap text-sm"
                      value={modelList}
                      onChange={(e) => setModelList(e.target.value)}
                      placeholder="publicai:swiss-ai/apertus-70b-instruct&#10;local:swiss-ai/Apertus-8B-Instruct-2509&#10;openai/gpt-4o-mini"
                    />
                    <p className="text-xs text-muted-foreground pt-1">
                      Nutze Präfixe wie <kbd className="bg-muted px-1 rounded">local:</kbd> für lokale Modelle (MLX) oder <kbd className="bg-muted px-1 rounded">publicai:</kbd> für das Gateway. Ohne Präfix wird OpenRouter genutzt.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'generator' && (
            <div className="w-full pb-16">
              <Tabs defaultValue="prompts" className="w-full">
                <TabsList className="mb-8 w-full flex h-14 p-1 bg-muted/50 rounded-xl">
                  <TabsTrigger value="prompts" className="flex-1 h-full text-base font-semibold rounded-lg">1. Prompts</TabsTrigger>
                  <TabsTrigger value="variables" className="flex-1 h-full text-base font-semibold rounded-lg">2. Variablen</TabsTrigger>
                  <TabsTrigger value="generate" className="flex-1 h-full text-base font-semibold rounded-lg">3. Start & Vorschau</TabsTrigger>
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
                                    {variables.filter(v => v !== 'Rolle' && v !== 'Avatar_Eigenschaften_und_Praeferenzen').map(v => (
                                      <div key={v} className="space-y-3">
                                        <Label className="text-base font-semibold text-foreground/80">{v}</Label>
                                        <Input
                                          value={roleVars[v] || ''}
                                          onChange={(e) => updateRoleVariable(role, v, e.target.value)}
                                          placeholder="Option 1, Option 2, Option 3..."
                                          className="text-base py-5 bg-muted/20"
                                        />
                                      </div>
                                    ))}

                                    <div className="space-y-3 md:col-span-2 pt-2">
                                      <Label className="text-base font-semibold text-foreground/80 flex items-center gap-2">
                                        Avatar-Eigenschaften und Präferenzen
                                        <Info className="w-4 h-4 text-muted-foreground" />
                                      </Label>
                                      <Input
                                        value={roleVars['Avatar_Eigenschaften_und_Praeferenzen'] || ''}
                                        onChange={(e) => updateRoleVariable(role, 'Avatar_Eigenschaften_und_Praeferenzen', e.target.value)}
                                        placeholder="Z.b: Mind. 3 Jahre Arbeitserfahrung..."
                                        className="text-base py-5 bg-muted/20"
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

          {activeTab === 'dashboard' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-16">

              <div className="flex items-center justify-between pb-4">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
                  <p className="text-muted-foreground">Analytics und Ergebnisse deines Fragebogens (Live-Export jederzeit möglich)</p>
                </div>
                <Button variant="outline" className="gap-2" onClick={downloadExcel} disabled={filteredResultsAll.length === 0}>
                  {isGenerating ? (
                    <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent flex animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  Excel Exportieren
                </Button>
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
                    <CardTitle>Tabellarische Übersicht</CardTitle>
                    <CardDescription>Daten-Matrix aller Likert-Werte aufgeschlüsselt nach Rolle und Modell (Durchschnitt aus {currentFilterN} Werten).</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="w-[200px] font-semibold">Rolle</TableHead>
                            <TableHead className="w-[200px] font-semibold">Modell</TableHead>
                            {tableData.columns.map(col => (
                              <TableHead key={col} className="text-center whitespace-nowrap font-semibold px-4">{col}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tableData.rows.sort((a, b) => a.role.localeCompare(b.role) || a.modelId.localeCompare(b.modelId)).map((row, idx) => (
                            <TableRow key={idx} className="hover:bg-muted/50 transition-colors">
                              <TableCell className="font-medium align-middle">{row.role}</TableCell>
                              <TableCell className="align-middle">
                                <Badge variant="outline" className="font-medium text-[10px] border-primary/20 text-primary bg-primary/5">{row.modelId}</Badge>
                              </TableCell>
                              {tableData.columns.map(col => (
                                <TableCell key={col} className="text-center tabular-nums align-middle px-4">
                                  {row[col] ? (
                                    <span className={Number(row[col]) >= 4 ? 'text-green-600 font-medium' : 'text-orange-600 font-medium'}>{row[col]}</span>
                                  ) : '-'}
                                </TableCell>
                              ))}
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
                                      <span className="text-sm">Lädt/Generiert (Erst-Download d. Modells kann dauern)...</span>
                                    </div>
                                  ) : (
                                    <div className="flex flex-col gap-3 py-1">
                                      {/* Tags for Variables */}
                                      <div className="flex gap-1.5 flex-wrap">
                                        {Object.entries(r.combo).filter(([k]) => k !== 'Rolle').map(([k, v]) => (
                                          <span key={k} className="bg-zinc-100 dark:bg-zinc-900 border px-1.5 py-0.5 rounded shadow-sm text-zinc-600 dark:text-zinc-400 font-mono text-[10px]">
                                            {v}
                                          </span>
                                        ))}
                                      </div>

                                      {/* Extracted Likert Scores */}
                                      {r.status === 'success' && (
                                        <div className="flex gap-2 flex-wrap">
                                          {Object.entries(parseLikertScores(r.response)).map(([f, s]) => (
                                            <span key={f} className="text-xs bg-secondary text-secondary-foreground font-semibold px-2 py-0.5 rounded shadow-sm border">
                                              {f}: <span className={s >= 4 ? 'text-green-600' : 'text-orange-600'}>{s}</span>/7
                                            </span>
                                          ))}
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
