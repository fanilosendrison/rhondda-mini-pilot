# Rhondda Pilot – Data Collection Script

Mini-pilote pour la validation de la méthode **Rhondda**. Ce script collecte un pool de 30 réponses pour 200 items du dataset **GSM8K** en utilisant `gpt-5.4-mini` (OpenAI) via le harness robuste [`llm-runtime`](https://www.npmjs.com/package/llm-runtime).

Le fichier de sortie (`gsm8k_pool.jsonl`) servira à l'analyse post-hoc (bootstrap, calcul de la stabilité, courbes accuracy vs k) dans la seconde phase.

---

## 📦 Prérequis

- Node.js **18+** (ESM support)
- Une clé API OpenAI avec accès au modèle `gpt-5.4-mini`
- Budget ~4 $ (estimé pour 200 items × 30 tirages)

---

## 🚀 Installation

Clonez ce dépôt, puis installez les dépendances :

```bash
npm install