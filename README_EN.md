<div align="center">

<img src="public/favicon.svg" width="76" height="76" alt="Open Medical logo" />

# Open Medical

### Aspiring to be a desktop agent that grows alongside doctors.

An open-source desktop agent · Patients & records · Knowledge & tasks

[![License: MIT](https://img.shields.io/badge/License-MIT-28735b?style=flat-square)](LICENSE)
[![Desktop](https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-334155?style=flat-square)](docs/DESKTOP.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.18-28735b?style=flat-square)](package.json)

[中文](README.md) · **English**

[Watch the tour](#product-tour) · [Quick start](#quick-start) · [User guide](docs/DOCTOR_WORKBENCH_GUIDE.md) · [Documentation](#documentation)

</div>

---

Open Medical is an open-source desktop agent for doctors, available on macOS and Windows. It helps doctors manage patients, records, knowledge and tasks through natural language, connecting record organization, literature searches, document preparation and ongoing follow-up. We hope it can grow alongside doctors as their knowledge, experience and ways of working evolve.

**Keep records locally, connect your preferred model, and review the results.** Use local Ollama / vLLM servers, DeepSeek, OpenAI, Anthropic, OpenRouter or an OpenAI-compatible endpoint.

![Patient pre-visit overview](docs/assets/features/patient-overview.png)

## Start here

| What you want to do | Where to start |
| :--- | :--- |
| Install and run | [Quick start](#quick-start) |
| Create records, read reports and prepare documents | [Patients and records](#patients) · [Task templates](#clinical-templates) |
| Handle daily tasks, follow-up and messages | [Tasks and messaging](#followup) |
| Organize knowledge, search literature and do research | [Knowledge and research](#knowledge) |
| Use file tools, models and automation | [Workspaces and customization](#workspace) |

## Product tour

**Watch the product tour · 79 seconds**

[![Open Medical product tour: patient records, follow-up and a personal knowledge library](docs/assets/open-medical-preview.gif)](https://github.com/JuneYaooo/open-medical-workbench/blob/main/docs/assets/open-medical-tour.mp4)

<p align="center">
  <a href="https://github.com/JuneYaooo/open-medical-workbench/blob/main/docs/assets/open-medical-tour.mp4"><strong>▶ Watch the full tour · 79 seconds · Chinese narration and subtitles</strong></a>
  <br />
  <sub>Click the preview to open the video. The tour uses sample records; some screens have changed in newer versions.</sub>
</p>

## Quick start

With a desktop package, open `Open Medical.app` on macOS or run `Open Medical.exe` from the complete portable folder on Windows. The app starts its local runtime automatically.

To launch from source, install **Node.js ≥ 22.18** and npm:

```bash
git clone https://github.com/JuneYaooo/open-medical-workbench.git
cd open-medical-workbench
npm ci
npm run build
npm start
```

`npm start` opens the desktop app. `npm run desktop`, `npm run agent` and `npm run harness` use the same entry point.

**First steps:** Open Example walkthroughs → Prepare all examples to explore ready-made records, or create a patient → add material → select a model → start a task. Patient records, clinical entries and follow-up records can be managed without a model; asking the assistant or starting a task requires a connected model, and nothing answers in its place when none is connected.

### Build desktop packages

Build a portable package on the corresponding operating system:

```bash
npm run package:mac    # macOS
npm run package:win    # Windows: build on Windows
```

Packages are written to `release/`. Open the `.app` on macOS or run `Open Medical.exe` from the complete portable folder on Windows. Source launches and installed packages share the desktop data directory. Closing the window can leave the app running in the background; quitting stops it. See [desktop setup](docs/DESKTOP.md) for installation, platform verification and signing limitations.

### Connect a model

Use **Settings → Model & runtime → Select model** to choose an available connection. Manage provider endpoints and credentials in connection configuration, or open **Settings → Desktop app → App maintenance → Open configuration folder**, edit `model.env`, then restart the app.

| Connection | Use case |
| :--- | :--- |
| Local Ollama / vLLM | Use your own model server; offline operation requires the model and dependencies to be available locally. |
| DeepSeek / OpenAI / Anthropic / OpenRouter | Bring your own API key; usage is billed by the provider. |
| OpenAI-compatible endpoint | Configure a self-hosted or third-party endpoint and model ID. |

Context and output limits can be adjusted in model settings. External models receive authorized source material and relevant context; local storage does not make cloud inference local.

## Feature guide

These screens use fictional example records. Expand a feature to read its description and view its screenshots; click an image for the full-size view.

<a id="patients"></a>

### Patients and clinical records

<details>
<summary><strong>Patient management and intake</strong></summary>

Find patients by name, identifier, group or tag, and manage active and archived records. Create records manually, preview roster imports, or upload clinical documents and review the resulting intake draft. Roster imports do not overwrite existing charts.

![Patient management and intake](docs/assets/features/patients.png)

![Patient management and intake](docs/assets/features/patient-import.png)

</details>

<details>
<summary><strong>Pre-visit overview</strong></summary>

Review diagnoses, medications, allergies, recent results and outstanding tasks in one place. Open the underlying records to check details and sources before a visit.

![Pre-visit overview](docs/assets/features/patient-overview.png)

</details>

<details>
<summary><strong>Diagnoses, history and visits</strong></summary>

Maintain the clinical summary, diagnoses and visit history with dates and sources. Review and edit missing details while keeping visits and source documents associated with the same patient.

![Diagnoses, history and visits](docs/assets/features/patient-clinical.png)

![Diagnoses, history and visits](docs/assets/features/patient-visits.png)

</details>

<details>
<summary><strong>Medications, allergies and treatment plans</strong></summary>

Distinguish active, stopped and unverified medication records, and retain doses, frequencies and allergies. Record treatment goals, interventions, review dates and assessments. Safety prompts cover only the built-in rules.

![Medications, allergies and treatment plans](docs/assets/features/patient-medications.png)

</details>

<details>
<summary><strong>Lab imports and trends</strong></summary>

Import or enter lab results with dates, values, units and sources, then compare them over time. Conflicting same-day results remain available for review; measurements with different units are not merged into one trend.

![Lab imports and trends](docs/assets/features/patient-labs.png)

</details>

<details>
<summary><strong>Patient material library</strong></summary>

Keep notes, reports and medication lists under the patient record. Read originals, find files and start follow-up tasks from the material library, retaining documents and outputs for later use.

![Patient material library](docs/assets/features/patient-library.png)

</details>

<details>
<summary><strong>Visit preparation and assistance</strong></summary>

Ask questions using the current patient chart and selected materials, prepare visit notes or documents, and compare similar cases. Proposed chart changes require review before being written.

![Visit preparation and assistance](docs/assets/features/patient-assistance.png)

</details>

<a id="clinical-templates"></a>

### Clinical and writing templates

Open these from Example walkthroughs → Task templates. Templates prepare the patient context and task request. Connect a model, review materials and permissions, and send the request. Outputs still require clinician review.

| Template | Purpose |
| :--- | :--- |
| **Complete intake** | Prepare a timeline, lab extracts, medication list and allergy summary. |
| **Clinical timeline** | Order scattered records by visit date with source references. |
| **Lab extraction** | Extract test names, values and units for source checking. |
| **Medication reconciliation** | Organize medication records and identify missing fields. |
| **Visit-note draft** | Structure presenting concerns, history and examination, flagging missing information. |
| **Medication reminders** | Flag allergies and cross-allergies, class-based interactions, same-class duplication and special-population cautions. Rules may miss risks; no reminder does not mean no risk. |
| **Patient education** | Rewrite existing plans and explanations in patient-friendly language. |
| **Lab-report explanation** | Prepare an explanation using the reference ranges printed in the report. |
| **Discharge-summary draft** | Summarize the admission, discharge medication and documented follow-up instructions. |
| **Handoff draft** | Summarize current problems, key events and items for handoff. |
| **Evidence-linked flowcharts** | Prepare Mermaid flowcharts with source references for each supported step. |
| **Adverse-reaction review** | Match medication and reported findings, and prepare a Naranjo assessment. |
| **Case-report draft** | Organize case information and discussion points around the CARE framework. |
| **Evidence-search planning** | Prepare PICO questions, search expressions and evidence-review steps. |

For follow-up planning, questionnaires and contact records, see [Tasks, follow-up and messaging](#followup).

<a id="followup"></a>

### Tasks, follow-up and messaging

<details>
<summary><strong>Daily agenda and appointments</strong></summary>

Review due follow-ups, appointments, tests, referrals and patient alerts, then open the relevant patient from each item. Appointment records retain the date, reason and status.

![Daily agenda and appointments](docs/assets/features/agenda.png)

![Daily agenda and appointments](docs/assets/features/patient-appointments.png)

</details>

<details>
<summary><strong>Follow-up plans, questionnaires and contact records</strong></summary>

Use templates or custom steps to schedule follow-up and prepare questionnaires and checklists. Record the actual contact outcome, time, notes and next action. A generated reminder does not mean the patient has been contacted.

![Follow-up plans, questionnaires and contact records](docs/assets/features/followup-plans.png)

![Follow-up plans, questionnaires and contact records](docs/assets/features/patient-followups.png)

</details>

<details>
<summary><strong>Test and referral tracking</strong></summary>

Track each item from waiting for results through clinician review, notification and closure. Retain sources, review notes and notification records, with rescheduling, cancellation and reopening. This is local tracking without hospital-system integration.

![Test and referral tracking](docs/assets/features/patient-tracking.png)

</details>

<details>
<summary><strong>Patient inbox and reply review</strong></summary>

Review patient messages, alerts and reply drafts together, with access to linked conversations and charts. Edit or discard drafts; live messaging requires a configured channel and authorization.

![Patient inbox and reply review](docs/assets/features/messages.png)

</details>

<details>
<summary><strong>Automated outreach and chat follow-up</strong></summary>

Use connected WeCom or personal WeChat channels for follow-up. The personal WeChat flow supports AI drafts, clinician-confirmed sending, structured reply review and confirmed archiving. Chat follow-up turns existing conversations into follow-up records.

![Automated outreach and chat follow-up](docs/assets/features/followup-auto.png)

![Automated outreach and chat follow-up](docs/assets/features/followup-chat.png)

</details>

<details>
<summary><strong>Private assistants, Doctor Avatar and reminders</strong></summary>

Configure private assistants, the Doctor Avatar and doctor reminders separately. The Doctor Avatar answers public health-education questions from your knowledge bases, never gives individual diagnoses, and currently runs on Feishu only; reminder timing and content are configurable. Each channel requires its own account and setup.

![Private assistants, Doctor Avatar and reminders](docs/assets/features/settings-knowledge-bot.png)

![Private assistants, Doctor Avatar and reminders](docs/assets/features/settings-notifications.png)

</details>

<a id="knowledge"></a>

### Knowledge, cases and research

<details>
<summary><strong>Knowledge libraries and document management</strong></summary>

Create collections for guidelines, manuals, templates and patient-education materials. Read documents and manage imports and background processing from the library. Patient materials and shared knowledge are managed separately.

![Knowledge libraries and document management](docs/assets/features/knowledge.png)

![Knowledge libraries and document management](docs/assets/features/knowledge-documents.png)

</details>

<details>
<summary><strong>Search and source verification</strong></summary>

Search by question, keyword, document type and source status. Inspect cited lines before continuing into a question-answering task. Keyword retrieval remains available when the embedding service is unavailable, with an explicit notice in the UI.

![Search and source verification](docs/assets/features/knowledge-reader.png)

</details>

<details>
<summary><strong>Sources, versions and sharing permissions</strong></summary>

Maintain author or institution, publication year, source URL and edition. Retire outdated sources while retaining historical references. External citation permission is separate and must be renewed after source changes.

![Sources, versions and sharing permissions](docs/assets/features/knowledge-source.png)

</details>

<details>
<summary><strong>Knowledge graphs and document diagrams</strong></summary>

Generate entity relationships, mind maps or process diagrams from documents and return to the supporting text from nodes. The screenshot shows the generation entry point. A processing model is required; unsupported relationships are not filled in automatically.

![Knowledge graphs and document diagrams](docs/assets/features/knowledge-map.png)

</details>

<details>
<summary><strong>Case library and similar-case retrieval</strong></summary>

Save case summaries, key results, treatment histories, outcomes and lessons. Search, bookmark and edit cases, or compare them with the current patient while distinguishing matches, differences and unknowns.

![Case library and similar-case retrieval](docs/assets/features/cases.png)

</details>

<details>
<summary><strong>Literature search</strong></summary>

Search PubMed or Europe PMC, review abstracts and citations, and bring literature into a task. Use the evidence-planning template to prepare PICO questions and search expressions first. Live searches require internet access.

![Literature search](docs/assets/features/literature.png)

</details>

<details>
<summary><strong>Clinical-trial prescreening</strong></summary>

Save protocols and eligibility criteria, run rule-based prescreening against patient charts, and review each criterion as met, unmet or unknown. AI assessments and clinician review remain separate, with enrollment tracking. Prescreening is not a final eligibility decision.

![Clinical-trial prescreening](docs/assets/features/trial-screening.png)

</details>

<details>
<summary><strong>Research statistics and de-identified exports</strong></summary>

Upload a CSV or select an existing dataset for descriptive statistics, group comparisons, two-group sample-size estimates and field-based de-identification. Built-in fictional data lets you try the local calculations without a model.

![Research statistics and de-identified exports](docs/assets/features/statistics.png)

</details>

<details>
<summary><strong>Clinical reference tools</strong></summary>

Use local scale calculators, lab reference entries, common ICD-9-CM-3 procedure codes and adverse-reaction matching. Follow the lab report and institutional code set where applicable; adverse-reaction matches do not establish causality.

![Clinical reference tools](docs/assets/features/reference-scales.png)

![Clinical reference tools](docs/assets/features/reference-labs.png)

![Clinical reference tools](docs/assets/features/reference-codes.png)

![Clinical reference tools](docs/assets/features/reference-adr.png)

</details>

<details>
<summary><strong>Single-case and batch DRG examples</strong></summary>

Run single-case grouping or CSV batch estimates from diagnoses, procedures and costs, with configurable rates and imported weights. This uses simplified demonstration rules and cannot be used for reimbursement. Importing weights does not supply a full grouper.

![Single-case and batch DRG examples](docs/assets/features/drg.png)

</details>

<a id="workspace"></a>

### Workspaces and customization

<details>
<summary><strong>Conversations, materials and task history</strong></summary>

Start a patient-linked or independent task, select materials, ask questions and inspect outputs and execution history. Continue editing or download files, and reopen tasks from the task directory.

![Conversations, materials and task history](docs/assets/features/tasks.png)

</details>

<details>
<summary><strong>Project files and change review</strong></summary>

Connect a local folder as a project to read and organize files with project-specific permissions. Review proposed edits and diffs before applying changes under the selected approval mode. Projects and patient charts are managed separately.

![Project files and change review](docs/assets/features/projects.png)

</details>

<details>
<summary><strong>Browser, media and analysis tools</strong></summary>

The assistant uses a browser the way a person does: it opens any website, clicks, types, selects and scrolls by numbered page elements, and hands screenshots to a vision model to read the page. The work panel shows the assistant browser live and accepts clicks; for logins or captchas you can show the browser window and finish them yourself, and the sign-in stays within the project. The analysis terminal and Office page previews require Docker plus a pre-imported local image, entered in the project Connections panel.

![Browser, media and analysis tools](docs/assets/features/project-browser.png)

![Browser, media and analysis tools](docs/assets/features/project-extensions.png)

</details>

<details>
<summary><strong>Skills, connected tools and automation rules</strong></summary>

Use built-in medical Skills and manage personal skills and automation rules. MCP servers and offline plugins are currently added through the local workspace API (`POST /api/workspaces/:id/extensions`); once added, they can be enabled, disabled and scoped per project in the Connections panel. Request custom behavior through conversation and review proposals before applying them.

![Skills, connected tools and automation rules](docs/assets/features/settings-skills.png)

![Skills, connected tools and automation rules](docs/assets/features/settings-connections.png)

![Skills, connected tools and automation rules](docs/assets/features/settings-workbench.png)

</details>

<details>
<summary><strong>Doctor preferences and reusable memory</strong></summary>

Save confirmed working preferences, writing habits and lessons. Review, edit, disable or delete memories and manage learning permissions. Knowledge and preferences are reused through retrieval and context; they do not automatically train the model.

![Doctor preferences and reusable memory](docs/assets/features/doctor-memory.png)

![Doctor preferences and reusable memory](docs/assets/features/settings-learning.png)

</details>

<details>
<summary><strong>Scheduled tasks</strong></summary>

Schedule one-time, recurring-interval or timezone-aware Cron tasks with explicit model and execution authorization. The service must remain running; schedules do not automatically approve file changes.

![Scheduled tasks](docs/assets/features/scheduled-tasks.png)

</details>

<details>
<summary><strong>Remote jobs and workers</strong></summary>

Connect a private queue and worker, select files and authorize upload, then check status and import results locally. Remote edits become reviewable proposals with conflict checks. A separately configured remote service is required.

![Remote jobs and workers](docs/assets/features/remote-jobs.png)

</details>

<details>
<summary><strong>Models and OCR</strong></summary>

Switch available models under Settings → Model & runtime → Select model, and review permission to process task materials. Configure local OCR and an optional vision model separately. Recognition quality depends on the source image and configured services.

</details>

<details>
<summary><strong>Built-in example walkthroughs</strong></summary>

Prepare three fictional patients with notes, labs, follow-ups, knowledge documents, cases, a study protocol and research CSV data. Open guided scenarios without uploading your own records. The example pack can be removed separately.

![Built-in example walkthroughs](docs/assets/features/examples.png)

</details>

<details>
<summary><strong>Desktop preferences and background tasks</strong></summary>

Manage login startup, system reminders and app maintenance in Settings. Open the patient data and model configuration folders separately. Close or hide the work window while background tasks continue, then return from the Dock or tray. PDF exports use the system save dialog.

</details>

## Data and scope

- **Local storage.** Patient records, messages, follow-ups and conversations are stored in local SQLite. Model connection keys are encrypted in a local credential vault. **The patient database itself is not encrypted.**
- **Explicit authorization.** Model requests follow the scope authorized in the UI. Scheduled tasks and automatic follow-up summaries need separate authorization. File proposals and diffs are available; workspace settings determine the approval mode.
- **Doctor review.** AI output assists organization and preparation. Clinical effectiveness has not been validated, and output cannot replace professional judgment. Built-in medication and lab rules are reminders, not a complete drug knowledge base, and may miss risks.
- **Single-doctor use.** Multi-user permissions, institution-grade audit, HIS / EMR / FHIR integration and institutional deployment validation are not implemented.

<details>
<summary><strong>Storage, backup and recovery</strong></summary>

The patient database is stored at `~/.open-medical-workbench/medical.sqlite`. Open it through **Settings → Desktop app → App maintenance → Open data folder**. Model configuration lives in a separate configuration folder. From a source checkout, create a consistent database backup with:

```bash
npm run backup
```

Quit the app before recovery and follow the [backup and recovery steps](docs/DESKTOP.md#备份与恢复), preserving the existing files first. Backups contain medical information and require the same protection as the original database. Deleting a patient also deletes their workspace and associated records; existing exports and backups remain.

</details>

## An extensible agent runtime

The medical workbench shares a general-purpose agent runtime for model/tool loops, file workspaces, conversation branches, scheduled tasks, context management and background execution. Extend it with Skills, MCP, plugins, browser tools, terminal tools and office-file helpers.

The generic runtime also provides a headless CLI and local API for extensions and task execution:

```bash
npm run workspace --   # CLI usage
npm run platform       # Local API without a workbench page
```

For development, run `npm run dev:server` with its separate development database, then `npm run dev:ui` for Vite. Use `npm run dev:platform` to debug the generic UI. The desktop runtime does not serve its UI or bootstrap credentials to external browsers. See [development setup](docs/DESKTOP.md#开发调试).

Docker is optional and used for containerized terminal and some office tools. See the [runtime compatibility](RUNTIME_COMPATIBILITY.md) for supported scope.

## Documentation

Most detailed guides are currently in Chinese.

| Topic | Guide |
| :--- | :--- |
| First use and doctor workflows | [Doctor workflow guide](docs/DOCTOR_WORKBENCH_GUIDE.md) |
| Desktop installation, builds and data | [Desktop setup](docs/DESKTOP.md) |
| Doctor reminders and Doctor Avatar | [Connection guide](docs/doctor-assistant-channels.md) |
| WeChat, WeCom and message archiving | [Chat connectors](docs/chat-connectors.md) |
| Patient, message and follow-up data | [Patient management](docs/PATIENTS.md) |
| Clinical interface, interaction rules and task validation | [Development guide](docs/DEVELOPMENT_GUIDE.md) |
| Architecture and extensions | [Architecture](docs/ARCHITECTURE.md) · [Plugin guide](docs/PLUGIN_GUIDE.md) · [Generic runtime](docs/GENERIC_RUNTIME.md) · [Orchestration](docs/ORCHESTRATION.md) |
| Runtime compatibility | [Runtime compatibility](RUNTIME_COMPATIBILITY.md) |
| Private task queues and workers | [Remote deployment](deploy/remote/README.md) |

## Contributing

Report bugs or suggest improvements through [Issues](https://github.com/JuneYaooo/open-medical-workbench/issues), or contribute code and documentation through pull requests. Include reproduction steps, operating system and version information. Remove patient information and credentials before sharing.

For changes to clinical interfaces or workflows, follow the [development guide](docs/DEVELOPMENT_GUIDE.md) and validate the complete task, data states and recovery from failures.

Run checks locally for code changes:

```bash
npm run check           # Lint and production build
```

## License

[MIT](LICENSE)

## Community

[LINUX DO](https://linux.do/)
