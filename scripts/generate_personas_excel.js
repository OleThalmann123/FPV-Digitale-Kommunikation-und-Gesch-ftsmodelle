/* eslint-disable @typescript-eslint/no-require-imports */
// Generiert personas_24.xlsx mit allen 24 Persona-Kombinationen.
// Spalte "Avatar Eigenschaften und Präferenzen" buendelt Jobbezeichnung,
// Jobbeschreibung, Berufserfahrung und die Avatar-Eigenschaften (1:1 aus
// src/app/page.tsx). Die separate Spalte Berufserfahrung entfaellt.
// Aufruf: node scripts/generate_personas_excel.js

const XLSX = require('xlsx');
const path = require('path');

// Avatar-Eigenschaften 1:1 aus src/app/page.tsx (roleEigenschaften).
const roleEigenschaften = {
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
Weitere Kenntnisse: Project Management / Funnel Optimization / A/B Testing, Marketing Strategy / Campaign Management, Campaign Management / Performance Marketing`,
};

// Berufserfahrung 1:1 aus src/app/page.tsx (roleWorkExperience).
const roleWorkExperience = {
  'CEM (Customer Experience Manager)': '5-7 Jahre',
  'SMM (Social Media Manager)': '2-5 Jahre',
  'DMM (Digital Manager)': '2-4 Jahre',
  'Growth Manager': '2-4 Jahre',
  'Kommunikation Manager': '4-6 Jahre',
  'Webseiten Manager': '5-7 Jahre',
};

// Ausgeschriebene Jobbezeichnung pro Rolle und selbst formulierte
// Jobbeschreibung (max. 3 Saetze).
const ROLE_META = {
  'CEM (Customer Experience Manager)': {
    jobbezeichnung: 'Customer Experience Manager',
    jobbeschreibung:
      'Verantwortet die End-to-End-Customer-Journey und sorgt für konsistente, positive Kundenerlebnisse über alle Touchpoints. Analysiert Feedback, NPS und Verhaltensdaten, um Reibungspunkte zu reduzieren und Kundenbindung zu stärken. Arbeitet eng mit Marketing, Vertrieb und Service zusammen, um Prozesse kundenzentriert zu gestalten.',
  },
  'SMM (Social Media Manager)': {
    jobbezeichnung: 'Social Media Manager',
    jobbeschreibung:
      'Plant, erstellt und veröffentlicht Inhalte auf Social-Media-Kanälen und steuert das Community-Management. Beobachtet Trends, KPIs und Reichweiten, um Content-Strategien laufend zu optimieren. Setzt Paid- und Organic-Kampagnen zur Markenstärkung und Lead-Generierung um.',
  },
  'DMM (Digital Manager)': {
    jobbezeichnung: 'Digital Manager',
    jobbeschreibung:
      'Steuert digitale Kanäle und Massnahmen, um Marken sichtbar zu machen und die Online-Performance zu steigern. Verantwortet Strategie und Umsetzung von SEO, SEA, E-Mail, Display und Social Ads. Analysiert Performance-Daten und optimiert Budgets entlang des Funnels.',
  },
  'Growth Manager': {
    jobbezeichnung: 'Growth Manager',
    jobbeschreibung:
      'Treibt skalierbares Nutzer- und Umsatzwachstum durch experimentelle Massnahmen entlang des gesamten Funnels. Nutzt Daten, Hypothesen und schnelle Tests, um Akquise, Aktivierung und Retention zu verbessern. Arbeitet eng mit Produkt, Marketing und Engineering zusammen.',
  },
  'Kommunikation Manager': {
    jobbezeichnung: 'Kommunikationsmanager',
    jobbeschreibung:
      'Verantwortet die interne und externe Kommunikation und sichert eine konsistente Markenstimme. Plant Pressemitteilungen, Statements, Krisenkommunikation und Stakeholder-Dialoge. Schreibt Inhalte, briefed Agenturen und steuert den Content-Kalender.',
  },
  'Webseiten Manager': {
    jobbezeichnung: 'Website Manager',
    jobbeschreibung:
      'Verantwortet Konzeption, Pflege und Weiterentwicklung der Unternehmenswebsite. Überwacht Performance, SEO, UX und Conversion und steuert Anpassungen mit Entwicklung und Design. Sorgt für rechtssichere, barrierearme Inhalte und einen reibungslosen technischen Betrieb.',
  },
};

const ROLES = Object.keys(ROLE_META);
const GESCHLECHTER = ['Männlich', 'Weiblich'];
const HAUSHALTE = ['1 Person kein Kind', '2 Personen 1 Kind'];

function buildAvatarText(role) {
  const meta = ROLE_META[role];
  return [
    `Jobbezeichnung: ${meta.jobbezeichnung}`,
    `Jobbeschreibung: ${meta.jobbeschreibung}`,
    `Berufserfahrung: ${roleWorkExperience[role]}`,
    roleEigenschaften[role],
  ].join('\n');
}

const rows = [];
let id = 1;
for (const role of ROLES) {
  for (const g of GESCHLECHTER) {
    for (const h of HAUSHALTE) {
      rows.push({
        ID: id++,
        Rolle: role,
        Geschlecht: g,
        Alter: '20-29 Jahre',
        Nationalitaet: 'Schweiz',
        Haushalt: h,
        Ausbildung: 'Bachelor',
        Wohnsitzland: 'Schweiz',
        Postleitzahl: '9000',
        'Avatar Eigenschaften und Präferenzen': buildAvatarText(role),
      });
    }
  }
}

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);

ws['!cols'] = [
  { wch: 4 },   // ID
  { wch: 36 },  // Rolle
  { wch: 11 },  // Geschlecht
  { wch: 13 },  // Alter
  { wch: 13 },  // Nationalitaet
  { wch: 22 },  // Haushalt
  { wch: 18 },  // Ausbildung
  { wch: 13 },  // Wohnsitzland
  { wch: 11 },  // Postleitzahl
  { wch: 110 }, // Avatar Eigenschaften und Präferenzen
];

XLSX.utils.book_append_sheet(wb, ws, 'Personas_24');

const outPath = path.join(__dirname, '..', 'personas_24.xlsx');
XLSX.writeFile(wb, outPath);
console.log(`Excel generiert: ${outPath} (${rows.length} Zeilen)`);
