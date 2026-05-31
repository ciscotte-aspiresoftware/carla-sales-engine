const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat, TableOfContents,
  ExternalHyperlink
} = require("/Users/Christophe.Sicotte/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/dc8feb4f-90e7-4709-b30f-a61272e0b7cd/958a751c-55e2-4117-8574-4372ac894147/skills/docx/node_modules/docx");
const fs = require("fs");

// ── Colors ────────────────────────────────────────────────────────────────────
const DARK_BLUE = "1E3A5F";
const MID_BLUE  = "2E5F8F";
const LIGHT_BLUE_BG = "EBF2FA";
const HEADER_BG = "1E3A5F";
const TABLE_HEADER_BG = "1E3A5F";
const TABLE_ALT_BG = "F0F5FB";
const BORDER_COLOR = "C5D8EE";
const BODY_FONT = "Arial";

// ── Page layout ───────────────────────────────────────────────────────────────
const PAGE = { width: 12240, height: 15840 };
const MARGIN = { top: 1440, right: 1260, bottom: 1440, left: 1260 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right; // 9720

// ── Style helpers ─────────────────────────────────────────────────────────────
const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 400, after: 200 },
  children: [new TextRun({ text, bold: true, size: 32, color: DARK_BLUE, font: BODY_FONT })]
});

const h2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 320, after: 160 },
  children: [new TextRun({ text, bold: true, size: 26, color: MID_BLUE, font: BODY_FONT })]
});

const h3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text, bold: true, size: 22, color: MID_BLUE, font: BODY_FONT })]
});

const body = (text, opts = {}) => new Paragraph({
  spacing: { before: 80, after: 120 },
  children: [new TextRun({ text, size: 22, font: BODY_FONT, ...opts })]
});

const italic = (text) => new Paragraph({
  spacing: { before: 60, after: 100 },
  children: [new TextRun({ text, size: 22, font: BODY_FONT, italics: true, color: "555555" })]
});

const bullet = (text, level = 0) => new Paragraph({
  numbering: { reference: "bullets", level },
  spacing: { before: 60, after: 60 },
  children: [new TextRun({ text, size: 22, font: BODY_FONT })]
});

const numbered = (text, ref = "numbers") => new Paragraph({
  numbering: { reference: ref, level: 0 },
  spacing: { before: 60, after: 60 },
  children: [new TextRun({ text, size: 22, font: BODY_FONT })]
});

const subBullet = (text) => bullet(text, 1);

const spacer = (pt = 160) => new Paragraph({
  spacing: { before: 0, after: pt },
  children: [new TextRun({ text: "", size: 22 })]
});

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

const sectionLabel = (text) => new Paragraph({
  spacing: { before: 80, after: 60 },
  children: [new TextRun({ text, bold: true, size: 22, font: BODY_FONT, color: DARK_BLUE })]
});

// ── Table helpers ─────────────────────────────────────────────────────────────
const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR };
const allBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function headerCell(text, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: allBorders,
    shading: { fill: TABLE_HEADER_BG, type: ShadingType.CLEAR },
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true, size: 20, color: "FFFFFF", font: BODY_FONT })]
    })]
  });
}

function dataCell(text, width, shade = false) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: allBorders,
    shading: { fill: shade ? TABLE_ALT_BG : "FFFFFF", type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 140, right: 140 },
    children: [new Paragraph({
      spacing: { before: 0, after: 0 },
      children: [new TextRun({ text, size: 20, font: BODY_FONT })]
    })]
  });
}

// ── ICP Table ────────────────────────────────────────────────────────────────
const icpTable = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: [2400, 1440, 1080, 4800],
  rows: [
    new TableRow({ children: [
      headerCell("Criterion", 2400),
      headerCell("Threshold", 1440),
      headerCell("Weight", 1080),
      headerCell("Rationale", 4800),
    ]}),
    new TableRow({ children: [
      dataCell("Fleet Size", 2400, false),
      dataCell(">= 25 vehicles", 1440, false),
      dataCell("0.25", 1080, false),
      dataCell("Operators below 25 vehicles don’t generate enough inbound call volume to justify Carla. Above 25, the ROI case is clear.", 4800, false),
    ]}),
    new TableRow({ children: [
      dataCell("Services Offered", 2400, true),
      dataCell("Airport transfer, insurance replacement, van hire, or long-term lease", 1440, true),
      dataCell("0.30", 1080, true),
      dataCell("These service lines generate the highest inbound call volume from multiple sources. Operators running these lines feel staffing pressure most acutely.", 4800, true),
    ]}),
    new TableRow({ children: [
      dataCell("Tech Maturity Score", 2400, false),
      dataCell(">= 2 out of 5", 1440, false),
      dataCell("0.30", 1080, false),
      dataCell("Carla layers on top of an existing RMS. The operator needs at least a basic digital infrastructure to integrate with. Unlike RMS vendors, Carla targets operators who already have a system but need the voice layer.", 4800, false),
    ]}),
    new TableRow({ children: [
      dataCell("Ownership Type", 2400, true),
      dataCell("Family, corporate, or franchisee", 1440, true),
      dataCell("0.15", 1080, true),
      dataCell("Clear decision-making authority. Independent operators and franchisees have a single decision-maker (owner or GM) who can say yes.", 4800, true),
    ]}),
  ]
});

// ── API Keys Table ────────────────────────────────────────────────────────────
const apiTable = new Table({
  width: { size: CONTENT_WIDTH, type: WidthType.DXA },
  columnWidths: [2600, 1200, 5920],
  rows: [
    new TableRow({ children: [
      headerCell("Key", 2600),
      headerCell("Required", 1200),
      headerCell("Feature Unlocked", 5920),
    ]}),
    new TableRow({ children: [
      dataCell("Anthropic API Key", 2600, false),
      dataCell("Yes", 1200, false),
      dataCell("Powers every AI call — discovery, scoring, research, and copywriting. Without this, nothing works.", 5920, false),
    ]}),
    new TableRow({ children: [
      dataCell("Tavily API Key", 2600, true),
      dataCell("No", 1200, true),
      dataCell("Live web verification during discovery. Without it, discovery falls back to Claude’s training knowledge only — less accurate contact data.", 5920, true),
    ]}),
    new TableRow({ children: [
      dataCell("Apollo API Key", 2600, false),
      dataCell("No", 1200, false),
      dataCell("Enables “Search Apollo” on prospect detail pages. Finds verified decision-maker emails and LinkedIn profiles using a 4-tier seniority fallback.", 5920, false),
    ]}),
    new TableRow({ children: [
      dataCell("HubSpot Access Token", 2600, true),
      dataCell("No", 1200, true),
      dataCell("Enables “Push to HubSpot” on prospect detail pages. Creates Company + Contact records in HubSpot and returns a direct link to the record. Use a Private App token.", 5920, true),
    ]}),
    new TableRow({ children: [
      dataCell("Firecrawl API Key", 2600, false),
      dataCell("No", 1200, false),
      dataCell("Improves website scraping for JavaScript-heavy sites. A free local scraper fallback is always available without this key.", 5920, false),
    ]}),
  ]
});

// ── Title page children ───────────────────────────────────────────────────────
const titlePageChildren = [
  spacer(2800),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 240 },
    children: [new TextRun({ text: "CARLA SALES ENGINE", bold: true, size: 56, color: DARK_BLUE, font: BODY_FONT })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 400 },
    children: [new TextRun({ text: "Platform Guide", size: 40, color: MID_BLUE, font: BODY_FONT })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR, space: 1 } },
    spacing: { before: 0, after: 400 },
    children: [new TextRun({ text: "", size: 22 })]
  }),
  spacer(240),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 160 },
    children: [new TextRun({ text: "Hey Carla / Valsoft Corporation", size: 26, color: "444444", font: BODY_FONT })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 160 },
    children: [new TextRun({ text: "Confidential — Internal Use Only", size: 22, italics: true, color: "888888", font: BODY_FONT })]
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 0 },
    children: [new TextRun({ text: "May 31, 2026", size: 22, color: "888888", font: BODY_FONT })]
  }),
];

// ── Section 1 ────────────────────────────────────────────────────────────────
const section1 = [
  pageBreak(),
  h1("1. What Is the Carla Sales Engine?"),
  body("The Carla Sales Engine is an internal AI-powered outreach platform built exclusively for the Hey Carla sales team. It automates the top-of-funnel process: finding car rental operators in the US market, qualifying them against Carla’s ideal customer profile, generating personalized email sequences, and pushing qualified leads directly into HubSpot CRM."),
  spacer(120),
  body("The platform is built on three pillars:", { bold: true }),
  bullet("Discovery — Find real car rental operators across the US using AI and live web search"),
  bullet("Qualification — Score each operator against Carla’s ICP criteria automatically"),
  bullet("Outreach — Generate 3-touch personalized email sequences per prospect, ready to send"),
  spacer(120),
  body("It is not a generic CRM or marketing tool. Every feature, every email template, and every scoring criterion is configured specifically for Hey Carla’s go-to-market: mid-sized, multi-location car rental operators in the US who are not already in the Valsoft/Bluebird/Thermion ecosystem."),
];

// ── Section 2 ────────────────────────────────────────────────────────────────
const section2 = [
  spacer(160),
  h1("2. Architecture Overview"),
  body("The platform has two components that run together on your local machine (or a cloud server in production):"),
  spacer(120),
  sectionLabel("Backend — FastAPI (Python), port 8000"),
  bullet("Hosts all AI agents: discovery, ICP scoring, research, and copywriting"),
  bullet("Manages the database (SQLite locally, PostgreSQL in production)"),
  bullet("Exposes the REST API consumed by the frontend"),
  bullet("Integration registry: Apollo (contact search), HubSpot (CRM push), Tavily (web search), Firecrawl (website scraping)"),
  spacer(120),
  sectionLabel("Frontend — Next.js, port 3000"),
  bullet("The browser-based UI your sales team uses day-to-day"),
  bullet("All data flows through the backend API"),
  spacer(120),
  sectionLabel("Database"),
  bullet("SQLite for local development — no setup required"),
  bullet("PostgreSQL via Supabase for production — swap in the DATABASE_URL environment variable"),
  spacer(120),
  sectionLabel("Configuration (Pack System)"),
  bullet("All business logic — ICP criteria, email voice, personas, value props — lives in JSON pack files under backend/packs/"),
  bullet("Changing the ICP or email tone does not require code changes, only pack edits"),
  spacer(160),
  body("To start the platform locally: run ./start.sh from the SDR-Engine-main directory. Both servers start automatically and the browser opens to http://localhost:3000.", { italics: true }),
];

// ── Section 3 ────────────────────────────────────────────────────────────────
const section3 = [
  spacer(160),
  h1("3. The Pack System — How Carla Is Configured"),
  body("The engine is configured through a layered pack system. Think of it as the “brain” of the platform — it tells the AI who to target, how to score them, and how to write to them. Every AI decision traces back to a pack value."),
  spacer(120),
  body("Hey Carla has four packs active:"),
  spacer(120),
  h2("Vertical Pack: car_rental"),
  body("Defines the industry context: what car rental is, the key KPIs (RevPAVD, fleet utilization, counter time), common operational pains, buyer segments, and fleet size thresholds. This is the foundation every agent reads from."),
  spacer(100),
  h2("Vendor Pack: hey_carla"),
  body("Defines the selling company: Hey Carla, part of the Valsoft/Aspire Software portfolio. Contains brand voice guidelines, excluded customers (Bluebird and Thermion operators already served internally via Valsoft), and competitor signals (other AI voice providers such as Bland.ai, Retell.ai, PolyAI)."),
  spacer(100),
  h2("Product Pack: carla_voice_assistant"),
  body("The most important pack. Contains:"),
  bullet("ICP criteria and weights (fleet size, services, tech maturity, ownership type)"),
  bullet("Minimum ICP score threshold: 0.60"),
  bullet("Full persona profiles: Owner/GM and Operations Manager"),
  bullet("Value propositions and objection handles per persona"),
  bullet("Email sequence strategy: Teach-Teach-Ask, 3 touches"),
  bullet("Subject line style, CTA progression, and prohibited phrases"),
  spacer(100),
  h2("Regional Pack: us_en"),
  body("Defines the US English context: direct and ROI-focused tone, first-name basis from the first email, scheduling rules (no weekends, best send windows Tuesday/Wednesday/Thursday mornings), CAN-SPAM compliance language, and US cultural notes for car rental operators."),
  spacer(120),
  italic("To view or edit any pack: navigate to Pack Explorer in the left sidebar."),
];

// ── Section 4 ────────────────────────────────────────────────────────────────
const section4 = [
  pageBreak(),
  h1("4. Feature Walkthrough"),

  h2("4.1 Dashboard"),
  body("The home screen. Shows key pipeline metrics: total prospects in the database, qualified prospects (ICP score >= 0.60), campaigns run, and email sequences generated. Provides a quick overview of pipeline health at a glance."),

  spacer(140),
  h2("4.2 Discovery — Finding Prospects"),
  body("Discovery is how you populate the prospect database with real car rental operators. There are two modes, both accessible via Prospects > Discover in the sidebar."),
  spacer(100),
  h3("Auto Discovery (Recommended for first runs)"),
  body("Enter a location, click run, and the three-phase pipeline executes automatically:"),
  numbered("Enter a US city or region (e.g. “Orlando, Florida” or “Dallas, Texas”)"),
  numbered("Select a size preference: Any, Small/Independent, or Established operators"),
  numbered("Click Run Discovery"),
  numbered("Phase 1 — Generate: Claude uses its training knowledge to name real car rental businesses in that location. It outputs business names, addresses, estimated fleet sizes, ownership types, and confidence scores."),
  numbered("Phase 2 — Verify: Tavily (live web search) looks up each candidate’s real website and contact information. This grounds the AI output in real, current data."),
  numbered("Phase 3 — Enrich: Claude extracts structured contact data from the Tavily results — contact name, title, email, phone, services offered, and tech maturity score. Each field is tagged with its source (snippet = verified from web, training = AI knowledge only)."),
  numbered("Prospects are saved to the database automatically."),
  spacer(100),
  italic("Tip: Run discovery for multiple US cities in sequence to build your lead list. Recommended starting markets: Orlando, Phoenix, Denver, Dallas, Atlanta, Las Vegas."),
  spacer(100),
  h3("Interactive Discovery (Step-by-step control)"),
  body("Same three-phase pipeline, but you review and approve each phase before proceeding. Use this when you want to manually curate which candidates move forward, or inspect what the AI found before enriching."),
  spacer(100),
  h3("What makes a good discovery target?"),
  body("The engine is configured to find independent and regional multi-location operators. It automatically excludes major chains (Hertz, Enterprise, Avis, Budget, Sixt, etc.). High-value targets are operators with 25–200 vehicles across 2–10 locations, particularly those with airport presence, insurance replacement programs, or van/truck rental alongside standard passenger vehicles."),

  spacer(140),
  h2("4.3 Prospects — Managing Your Lead List"),
  body("The Prospects page is your master lead database. Every operator discovered or imported appears here."),
  spacer(100),
  h3("List View"),
  bullet("All discovered prospects with key columns: business name, location, fleet size, ICP score, ownership type, tech maturity"),
  bullet("Filter by: ICP score range, country, ownership type, online booking status, or free-text search"),
  bullet("Color-coded ICP score badges: green (≥ 0.75), amber (0.60–0.74), gray (not yet scored)"),
  bullet("Click any row to open the full prospect detail"),
  spacer(100),
  h3("Prospect Detail"),
  body("Full profile for a single prospect. Contains:"),
  bullet("Business info: name, website, location, fleet size, services, ownership type"),
  bullet("Contact info: primary contact name, email, phone"),
  bullet("ICP score and reasoning (shows why the AI scored them the way it did)"),
  bullet("Research profile: hook line, pain hypothesis, credible detail — the raw material the copywriter uses"),
  bullet("Website research: what the AI found by scraping their website"),
  bullet("Email sequences: all generated touches for this prospect"),
  bullet("Contacts tab: additional decision-makers at this company"),
  spacer(100),
  h3("Adding Contacts via Apollo"),
  body("Requires Apollo API key in Settings."),
  numbered("Open a prospect detail"),
  numbered("Click “Search Apollo” on the Contacts tab"),
  numbered("The engine searches Apollo’s database for decision-makers at that company’s domain using a 4-tier fallback: Founder/Owner > CEO/President > VP/Director > General Manager"),
  numbered("Top 3 contacts are saved automatically, deduplicated by email"),
  numbered("Each contact shows name, title, email, and LinkedIn URL"),
  spacer(100),
  h3("Pushing to HubSpot"),
  body("Requires HubSpot Access Token in Settings."),
  numbered("Open a prospect detail"),
  numbered("Click “Push to HubSpot”"),
  numbered("The engine creates or updates the Company record in HubSpot (name, domain, location, fleet size, ICP score)"),
  numbered("All saved contacts are pushed as Contact records and associated to the Company"),
  numbered("A direct link to the HubSpot company record is returned"),
  spacer(100),
  h3("CSV Upload"),
  body("Import an existing lead list via the CSV upload button on the Prospects page. Useful for seeding the database with lists from TSD, HQ Rental, Wheels, or other RMS vendors whose client lists you already have."),

  spacer(140),
  h2("4.4 Campaigns — Scoring, Research, and Email Generation"),
  body("A Campaign is the pipeline that takes a set of prospects and produces qualified, personalized email sequences ready for outreach."),
  spacer(100),
  h3("Creating a Campaign"),
  numbered("Navigate to Campaigns > New Campaign"),
  numbered("Name the campaign (e.g. “Orlando Q3 Outreach”)"),
  numbered("Select packs: Vertical = Car Rental, Vendor = Hey Carla, Product = Carla Voice Assistant, Regional = United States (English)"),
  numbered("Select prospects: search/filter and check the operators to include"),
  numbered("Set sequence settings: number of touches (default 3), days between touches (default 3)"),
  numbered("Click Create Campaign"),
  spacer(100),
  h3("Running the Pipeline"),
  body("Once created, click “Run Campaign”. The pipeline executes three stages in sequence:"),
  spacer(80),
  sectionLabel("Stage 1 — ICP Scoring (ProspectorAgent)"),
  body("All prospects are scored in a single batch call to Claude. Each prospect receives a score from 0 to 1 based on the ICP criteria in the product pack. The AI also writes a brief reasoning for each score explaining which criteria were met or missed. Prospects below 0.60 are marked as below threshold and skipped in later stages."),
  spacer(80),
  sectionLabel("Stage 2 — Research (ResearchAgent)"),
  body("For each prospect that passes the ICP threshold, the ResearchAgent generates a personalization profile:"),
  bullet("Hook line: a 1-sentence opener specific to their operation (≤ 30 words)"),
  bullet("Pain hypothesis: the specific operational pain this operator likely feels (≤ 25 words)"),
  bullet("Credible detail: an industry benchmark or relevant fact (≤ 20 words)"),
  bullet("Suggested persona: which contact role to address (Owner/GM or Operations Manager)"),
  bullet("Personalization notes: tone guidance and verified facts flagged for the copywriter"),
  spacer(80),
  body("Important: the researcher only cites facts that are verified from the prospect’s own website or Tavily search results. If data comes only from AI training knowledge, it uses hedged phrasing (“operations of your size”) rather than specific numbers. This prevents fabricated claims in outreach emails."),
  spacer(80),
  sectionLabel("Stage 3 — Copywriting (CopywriterAgent)"),
  body("For each prospect, Claude writes 3 email touches following the Teach-Teach-Ask strategy (see Section 6 for full detail). Subject lines are conversational and under 50 characters. The voice follows the us_en regional pack: direct, first-name basis, ROI-focused, under 120 words per email."),
  spacer(100),
  h3("Reviewing Sequences"),
  numbered("Open the campaign after the pipeline completes"),
  numbered("Each prospect shows its ICP score and sequence status"),
  numbered("Click a prospect to view all 3 email touches (subject line + body)"),
  numbered("You can approve, edit, or reject each sequence"),
  numbered("Copy individual emails to Gmail or Outlook for manual sending"),
  italic("Note: Automated sending via SendGrid is planned for Phase 3."),

  spacer(140),
  h2("4.5 Pack Explorer — Configuring the Engine"),
  body("The Pack Explorer lets you view and edit every configuration pack without touching code. This is where the sales lead adapts the ICP, adjusts the email voice, or updates value propositions based on what they learn in the field."),
  spacer(100),
  body("Navigate to Pack Explorer in the sidebar. The four active packs are:"),
  bullet("Vertical Packs: car_rental (the industry definition)"),
  bullet("Vendor Packs: hey_carla (the selling company)"),
  bullet("Product Packs: carla_voice_assistant (the product being sold)"),
  bullet("Regional Packs: us_en (United States English), plus au_en, nl_nl, es_es for future markets"),
  spacer(100),
  h3("What you can change without code"),
  bullet("ICP criteria weights and thresholds (in the product pack)"),
  bullet("Persona titles and primary motivators"),
  bullet("Value propositions and objection handles"),
  bullet("Email guidance: sequence strategy, CTAs, and prohibited phrases"),
  bullet("Brand voice: tone, favored phrasing, words to avoid"),
  bullet("Regional scheduling: best send windows and blackout periods"),
  spacer(100),
  h3("AI Auto-fill"),
  body("Each pack section has a Generate button. Click it, describe what you want in plain English, and the AI will draft the section. Useful for quickly updating objection handles after a discovery call, or refining value props based on prospect feedback."),

  spacer(140),
  h2("4.6 Live Activity Feed"),
  body("The Activity page shows a real-time log of every event in the system: prospects discovered, campaigns run, sequences generated, emails approved, and contacts found. Useful for monitoring pipeline activity and understanding what the AI did during a run."),

  spacer(140),
  h2("4.7 Costs & Models"),
  body("Shows token usage and estimated cost per AI agent, per campaign, and in total. You can also change which Claude model each agent uses — useful for balancing output quality against cost as volume scales. The default model is Claude Sonnet: fast, high quality, and cost-efficient for this workload."),

  spacer(140),
  h2("4.8 Settings — API Keys and Configuration"),
  body("Navigate to Settings in the left sidebar to configure API keys. Keys are encrypted at rest in the database and can be set here without editing .env files — no restarts required."),
  spacer(120),
  apiTable,
  spacer(120),
  body("HubSpot Private App scopes required: crm.objects.companies.write, crm.objects.contacts.write, crm.associations.write."),
];

// ── Section 5 ────────────────────────────────────────────────────────────────
const section5 = [
  pageBreak(),
  h1("5. Ideal Customer Profile (ICP) Reference"),
  body("The following criteria are currently configured in the product pack (backend/packs/product/carla_voice_assistant.json). Weights and thresholds can be adjusted at any time in Pack Explorer — no code deployment required."),
  spacer(160),
  icpTable,
  spacer(160),
  sectionLabel("Minimum passing score: 0.60"),
  spacer(80),
  sectionLabel("Primary sweet spot"),
  body("Multi-location independents with 25–200 vehicles, US market, airport or insurance replacement presence."),
  spacer(80),
  sectionLabel("Segments to avoid"),
  bullet("Single-location operators with fewer than 25 vehicles — insufficient call volume for Carla ROI"),
  bullet("Major chain franchisees where the technology decision is made at the brand level, not the operator level"),
  bullet("Peer-to-peer marketplaces (Turo, Getaround) — different business model, no staffed counter"),
  bullet("Bluebird and Thermion operators — already served internally via the Valsoft distribution channel"),
];

// ── Section 6 ────────────────────────────────────────────────────────────────
const section6 = [
  spacer(160),
  h1("6. Email Sequence Strategy"),
  body("All generated sequences follow the Teach-Teach-Ask framework. This is configured in the product pack and applies to every prospect in every campaign. The framework is designed to build credibility before making an ask."),
  spacer(140),
  h2("Touch 1 — Teach (Day 0)"),
  bullet("Subject: Conversational, specific, under 50 characters. Never mention AI in the subject line."),
  bullet("Body: Open with the operational cost of missed or mishandled reservation calls. One specific operational insight relevant to their fleet size and location. No product pitch. End with a soft curiosity hook."),
  bullet("CTA: “Worth a 15-minute call to see how operators your size are handling after-hours reservations?”"),
  spacer(100),
  h2("Touch 2 — Teach (Day 3)"),
  bullet("Subject: Reference a specific operational detail from their profile."),
  bullet("Body: Explain how Carla reads from their existing RMS — it does not replace it. Reference their specific pain point (airport runs, insurance calls, multi-location coverage). Brief and specific."),
  bullet("CTA: “Happy to show you a short demo of how Carla reads availability from your RMS — no commitment.”"),
  spacer(100),
  h2("Touch 3 — Ask (Day 6)"),
  bullet("Subject: Direct and low-pressure."),
  bullet("Body: Short, direct ask. Acknowledge the prior two emails without being sycophantic. Single clear ask."),
  bullet("CTA: “If it makes sense, I can set up a pilot at one of your locations — typically live in under a week.”"),
  spacer(140),
  h2("What the AI is instructed never to do"),
  bullet("Lead with “AI-powered” in the subject line"),
  bullet("Claim specific ROI numbers without the prospect’s own data"),
  bullet("Name competitors"),
  bullet("Use “synergy”, “leverage”, “circle back”, or “touch base”"),
  bullet("Write generic openers such as “I hope this finds you well”"),
  bullet("Pitch the full product in Touch 1"),
];

// ── Section 7 ────────────────────────────────────────────────────────────────
const section7 = [
  pageBreak(),
  h1("7. Recommended Workflow for the Sales Lead"),
  h2("Week 1 — Building the Initial Pipeline"),
  spacer(80),
  sectionLabel("Day 1 — Setup and first discovery runs"),
  numbered("Open the platform at http://localhost:3000"),
  numbered("Go to Settings and confirm API keys are configured (check with the technical founder)"),
  numbered("Go to Prospects > Discover"),
  numbered("Run Auto Discovery for 3–5 US cities: start with Orlando, Dallas, and Phoenix"),
  numbered("Each run takes 3–5 minutes and produces 10–20 prospects"),
  spacer(120),
  sectionLabel("Day 2–3 — Review and qualify"),
  numbered("Review prospects on the Prospects page"),
  numbered("Filter by ICP score >= 0.60 to surface the most qualified operators"),
  numbered("For interesting prospects: open the detail, click Search Apollo to find contact emails"),
  numbered("Create your first campaign: Campaigns > New Campaign"),
  numbered("Select 20–30 of your best prospects and run the pipeline"),
  numbered("The pipeline takes 5–10 minutes depending on the number of prospects"),
  spacer(120),
  sectionLabel("Day 4–5 — Review sequences and iterate"),
  numbered("Review the generated email sequences in the campaign"),
  numbered("Read through Touch 1, 2, and 3 for a handful of prospects"),
  numbered("Make notes on what’s working and what needs adjustment"),
  numbered("Any changes to voice or ICP? Update the relevant pack in Pack Explorer — no code required"),
  spacer(160),
  h2("Ongoing Cadence"),
  spacer(80),
  sectionLabel("Weekly"),
  bullet("Run discovery for 2–3 new US cities (rotate through: Las Vegas, Denver, Atlanta, Miami, Chicago, Houston, Seattle, Phoenix)"),
  bullet("Create one new campaign per week with the best new prospects"),
  bullet("Review sequences and copy approved ones to your email client"),
  spacer(120),
  sectionLabel("Monthly"),
  bullet("Review ICP score distribution — if too many prospects are failing, adjust criteria weights in Pack Explorer"),
  bullet("Update value props or objection handles based on real sales call feedback"),
  bullet("Push all qualified prospects to HubSpot for CRM tracking and pipeline management"),
];

// ── Section 8 ────────────────────────────────────────────────────────────────
const section8 = [
  spacer(160),
  h1("8. Technical Notes"),
  h2("Changing the ICP or Email Voice"),
  body("Edit backend/packs/product/carla_voice_assistant.json — adjust the criteria array, persona value props, or email_guidance fields. No code deployment needed. The backend reads packs from disk on each request, so changes take effect immediately."),
  spacer(100),
  h2("Switching to PostgreSQL for Production"),
  body("Set DATABASE_URL=postgresql://... in backend/.env. The engine uses SQLAlchemy and is fully PostgreSQL-compatible. Run the backend once — it creates all tables and indexes automatically on startup."),
  spacer(100),
  h2("Deploying to Production"),
  body("Recommended stack: Vercel for the frontend (free), Railway for the backend (~$5/month), and Supabase for PostgreSQL (free tier). The backend requires environment variables set in the Railway dashboard. The frontend requires NEXT_PUBLIC_API_URL set in Vercel pointing to the Railway backend URL."),
  spacer(100),
  h2("HubSpot Custom Properties"),
  body("The engine writes two custom properties to HubSpot Company records: car_fleet_size (number) and icp_score (number, 0–1). Create these in HubSpot Settings > Properties > Company Properties before the first push, or HubSpot will attempt to create them automatically."),
  spacer(100),
  h2("Geographic Coverage Expansion"),
  body("The discovery wizard accepts any location as free text. For systematic geographic coverage at scale, the companion Sheryar repository in this project folder contains a Scrapingdog Google Maps grid sweep system that can be integrated in Phase 3."),
];

// ── Section 9 ────────────────────────────────────────────────────────────────
const section9 = [
  spacer(160),
  h1("9. Roadmap"),
  h2("Phase 2 — Production Deployment (This Month)"),
  bullet("Supabase PostgreSQL migration"),
  bullet("Vercel + Railway production deployment"),
  bullet("Shareable URL for the sales lead — no localhost required"),
  spacer(120),
  h2("Phase 3 — Scale and Automation (Next Month)"),
  bullet("Geographic grid sweep (Scrapingdog) for systematic US market coverage city by city"),
  bullet("CSV import of TSD, HQ Rental, and Wheels client lists as seed data"),
  bullet("SendGrid integration for automated email sequence sending with open and click tracking"),
  spacer(120),
  h2("Phase 4 — Future"),
  bullet("Multi-sender personas: different sender names and voices per campaign"),
  bullet("Email reply ingestion and classification (interested / not interested / referral)"),
  bullet("LinkedIn outreach sequences"),
  bullet("Expansion to Canadian and European markets using existing regional packs"),
];

// ── Build document ────────────────────────────────────────────────────────────
const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          {
            level: 0, format: LevelFormat.BULLET, text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } }
          },
          {
            level: 1, format: LevelFormat.BULLET, text: "◦",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1080, hanging: 360 } } }
          },
        ]
      },
      {
        reference: "numbers",
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: "%1.",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      },
    ]
  },
  styles: {
    default: {
      document: { run: { font: BODY_FONT, size: 22, color: "222222" } }
    },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, color: DARK_BLUE, font: BODY_FONT },
        paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR, space: 4 } } }
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, color: MID_BLUE, font: BODY_FONT },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 }
      },
      {
        id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, color: MID_BLUE, font: BODY_FONT },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 }
      },
    ]
  },
  sections: [
    // ── Title page (no header/footer) ────────────────────────────────────────
    {
      properties: {
        page: { size: { width: PAGE.width, height: PAGE.height }, margin: MARGIN },
        titlePage: true,
      },
      children: titlePageChildren,
    },
    // ── TOC + body ───────────────────────────────────────────────────────────
    {
      properties: {
        page: { size: { width: PAGE.width, height: PAGE.height }, margin: MARGIN },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR, space: 4 } },
            children: [
              new TextRun({ text: "Carla Sales Engine — Platform Guide", size: 18, color: "888888", font: BODY_FONT }),
              new TextRun({ text: "\t", size: 18 }),
              new TextRun({ text: "Confidential — Internal Use Only", size: 18, color: "AAAAAA", italics: true, font: BODY_FONT }),
            ],
            tabStops: [{ type: "right", position: CONTENT_WIDTH }]
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            border: { top: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR, space: 4 } },
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: "Page ", size: 18, color: "888888", font: BODY_FONT }),
              new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "888888", font: BODY_FONT }),
              new TextRun({ text: " of ", size: 18, color: "888888", font: BODY_FONT }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "888888", font: BODY_FONT }),
            ]
          })]
        })
      },
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 200, after: 200 },
          children: [new TextRun({ text: "Table of Contents", bold: true, size: 32, color: DARK_BLUE, font: BODY_FONT })]
        }),
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
        ...section1,
        ...section2,
        ...section3,
        ...section4,
        ...section5,
        ...section6,
        ...section7,
        ...section8,
        ...section9,
      ]
    }
  ]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("/Users/Christophe.Sicotte/Documents/GitHub/carla-sales-engine/Carla_Sales_Engine_Guide.docx", buffer);
  console.log("SUCCESS: Carla_Sales_Engine_Guide.docx written");
}).catch(err => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
