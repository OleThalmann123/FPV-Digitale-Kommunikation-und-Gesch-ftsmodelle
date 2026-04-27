/* eslint-disable @typescript-eslint/no-require-imports */
// Generiert personas_24.xlsx mit einer Zeile pro Rolle und den Spalten
// Jobbezeichnung, Jobbeschreibung, Avatar Eigenschaften, Präferenzen.
// Aufruf: node scripts/generate_personas_excel.js

const XLSX = require('xlsx');
const path = require('path');

const ROLES = [
  {
    jobbezeichnung: 'Customer Experience Manager',
    jobbeschreibung:
      'Verantwortet die End-to-End-Customer-Journey und sorgt für konsistente, positive Kundenerlebnisse über alle Touchpoints. Analysiert Feedback, NPS und Verhaltensdaten, um Reibungspunkte zu reduzieren und Kundenbindung zu stärken. Arbeitet eng mit Marketing, Vertrieb und Service zusammen, um Prozesse kundenzentriert zu gestalten.',
    eigenschaften:
      'Empathisch, datenaffin, prozessorientiert, kommunikativ, lösungsorientiert.',
    praeferenzen:
      'CRM-Tools (Salesforce, HubSpot), Customer-Journey-Mapping, NPS- und VoC-Programme, Cross-Functional Workshops.',
  },
  {
    jobbezeichnung: 'Social Media Manager',
    jobbeschreibung:
      'Plant, erstellt und veröffentlicht Inhalte auf Social-Media-Kanälen und steuert das Community-Management. Beobachtet Trends, KPIs und Reichweiten, um Content-Strategien laufend zu optimieren. Setzt Paid- und Organic-Kampagnen zur Markenstärkung und Lead-Generierung um.',
    eigenschaften:
      'Kreativ, trendbewusst, kommunikativ, schnell reagierend, analytisch.',
    praeferenzen:
      'Instagram, TikTok, LinkedIn, Canva, Meta Business Suite, Hootsuite, Storytelling-Formate.',
  },
  {
    jobbezeichnung: 'Digital Manager',
    jobbeschreibung:
      'Steuert digitale Kanäle und Massnahmen, um Marken sichtbar zu machen und die Online-Performance zu steigern. Verantwortet Strategie und Umsetzung von SEO, SEA, E-Mail, Display und Social Ads. Analysiert Performance-Daten und optimiert Budgets entlang des Funnels.',
    eigenschaften:
      'Strategisch, datengetrieben, neugierig, kanalübergreifend denkend, ergebnisorientiert.',
    praeferenzen:
      'Google Ads, GA4, Meta Ads, Marketing-Automation, A/B-Testing, KPI-Dashboards.',
  },
  {
    jobbezeichnung: 'Growth Manager',
    jobbeschreibung:
      'Treibt skalierbares Nutzer- und Umsatzwachstum durch experimentelle Massnahmen entlang des gesamten Funnels. Nutzt Daten, Hypothesen und schnelle Tests, um Akquise, Aktivierung und Retention zu verbessern. Arbeitet eng mit Produkt, Marketing und Engineering zusammen.',
    eigenschaften:
      'Hypothesengetrieben, experimentierfreudig, analytisch, technisch versiert, ergebnisfokussiert.',
    praeferenzen:
      'Mixpanel, Amplitude, GrowthBook, A/B-Testing, SQL, North-Star-Metriken, Lean-Experimente.',
  },
  {
    jobbezeichnung: 'Kommunikationsmanager',
    jobbeschreibung:
      'Verantwortet die interne und externe Kommunikation und sichert eine konsistente Markenstimme. Plant Pressemitteilungen, Statements, Krisenkommunikation und Stakeholder-Dialoge. Schreibt Inhalte, briefed Agenturen und steuert den Content-Kalender.',
    eigenschaften:
      'Sprachgewandt, strategisch, vertrauenswürdig, gut vernetzt, krisensicher.',
    praeferenzen:
      'PR-Tools, Newsroom-Plattformen, LinkedIn, klassische Medien, redaktionelle Workflows, Storytelling.',
  },
  {
    jobbezeichnung: 'Website Manager',
    jobbeschreibung:
      'Verantwortet Konzeption, Pflege und Weiterentwicklung der Unternehmenswebsite. Überwacht Performance, SEO, UX und Conversion und steuert Anpassungen mit Entwicklung und Design. Sorgt für rechtssichere, barrierearme Inhalte und einen reibungslosen technischen Betrieb.',
    eigenschaften:
      'Detailgenau, technisch versiert, UX-affin, strukturiert, datengetrieben.',
    praeferenzen:
      'CMS (WordPress, Webflow, TYPO3), GA4, Search Console, Lighthouse, A/B-Testing, Figma.',
  },
];

const rows = ROLES.map((r) => ({
  Jobbezeichnung: r.jobbezeichnung,
  Jobbeschreibung: r.jobbeschreibung,
  'Avatar Eigenschaften': r.eigenschaften,
  'Präferenzen': r.praeferenzen,
}));

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);

ws['!cols'] = [
  { wch: 30 },  // Jobbezeichnung
  { wch: 90 },  // Jobbeschreibung
  { wch: 60 },  // Avatar Eigenschaften
  { wch: 60 },  // Präferenzen
];

XLSX.utils.book_append_sheet(wb, ws, 'Personas');

const outPath = path.join(__dirname, '..', 'personas_24.xlsx');
XLSX.writeFile(wb, outPath);
console.log(`Excel generiert: ${outPath} (${rows.length} Zeilen)`);
