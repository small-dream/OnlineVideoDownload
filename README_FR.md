<p align="center">
  <img src="icons/icon128.png" alt="Online Video Downloader" width="80" height="80">
  <h1 align="center">Online Video Downloader</h1>
  <p align="center">
    Détectez et téléchargez les vidéos en ligne de n'importe quelle page en un clic<br>
    <strong>YouTube</strong> · <strong>Bilibili</strong> · <strong>HLS</strong> · <strong>DASH</strong> · <strong>Blob</strong> · <strong>MP4</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
    <img src="https://img.shields.io/badge/Chrome-88%2B-green.svg" alt="Chrome 88+">
    <img src="https://img.shields.io/badge/Manifest-V3-purple.svg" alt="Manifest V3">
  </p>
  <p align="center">
    <a href="README.md">中文</a> · <a href="README_EN.md">English</a> · <a href="README_JA.md">日本語</a> · <strong>Français</strong>
  </p>
</p>

---

## ✨ Points forts

- 🎬 **Détection automatique** — Identifie automatiquement toutes les ressources vidéo d'une page, sans copier-coller d'URL
- ⬇️ **Téléchargement en un clic** — Enregistrez les vidéos d'un seul clic, ultra simple
- 🔀 **Fusion dans le navigateur** — Les flux audio/vidéo YouTube 1080p+ et Bilibili DASH sont fusionnés dans le navigateur — **pas besoin d'installer ffmpeg ou d'autres outils locaux**
- 🌐 **Compatibilité étendue** — Support spécialisé pour YouTube et Bilibili, plus les vidéos HLS / DASH / MP4 / Blob de n'importe quel site
- 🔒 **Confidentialité** — Tout le traitement se fait localement, aucune donnée n'est envoyée à des serveurs tiers
- 🛡️ **Respect des DRM** — Le contenu chiffré est signalé mais jamais contourné

---

## 🚀 Démarrage rapide (30 secondes)

> **Prérequis** : Chrome 88+ ou Edge 88+

### Étape 1 : Récupérer le code

```bash
git clone https://github.com/small-dream/OnlineVideoDownload.git
```

Ou téléchargez et extrayez le ZIP.

### Étape 2 : Charger l'extension

1. Ouvrez Chrome et allez sur `chrome://extensions`
2. Activez le **Mode développeur** (interrupteur en haut à droite)
3. Cliquez sur **Charger l'extension non empaquetée**
4. Sélectionnez le répertoire racine du projet (celui contenant `manifest.json`)

✅ C'est fait ! L'icône de l'extension apparaît dans la barre d'outils.

---

## 📖 Guide d'utilisation

### Basique : Télécharger une vidéo

1. **Ouvrez une page contenant une vidéo** (ex. : une page YouTube)
2. Attendez le chargement du lecteur vidéo — l'extension détecte les vidéos automatiquement
3. **Cliquez sur l'icône de l'extension** dans la barre d'outils pour voir les vidéos détectées
4. Trouvez la vidéo souhaitée et cliquez sur **Télécharger**
5. La barre de progression en bas affiche l'état du téléchargement en temps réel

> 💡 **Astuce** : Après l'installation de l'extension, toute vidéo sur toute page visitée est automatiquement détectée. Cliquez simplement sur l'icône pour voir ce qui est disponible.

### Téléchargements YouTube

| Résolution | Fonctionnement |
|-----------|----------------|
| ≤ 720p | Téléchargement direct (flux combiné avec audio) |
| 1080p+ | Téléchargement automatique des flux vidéo + audio et fusion dans le navigateur |

- Ouvrez une vidéo YouTube → cliquez sur l'icône de l'extension → choisissez la résolution → téléchargez
- Prend en charge le **Mode capture** (récupération des flux chargés par le navigateur) et le **Mode analyse** (récupération indépendante des flux)
- En mode analyse, vous pouvez sélectionner la résolution : 1080p, 720p, 480p, etc.

### Téléchargements Bilibili

- Nécessite d'**être connecté à un compte Bilibili** dans le navigateur (sans connexion, seul le 360P est disponible)
- Ouvrez une vidéo Bilibili → cliquez sur l'icône de l'extension → choisissez la qualité → téléchargez
- **Sélection automatique de la meilleure qualité disponible**, ou choix manuel d'une qualité spécifique
- Votre préférence de qualité est sauvegardée pour les prochains téléchargements
- Le contenu premium nécessite un compte premium

### Flux HLS / vidéos .m3u8

- Pour le live streaming ou la VOD en HLS, l'extension télécharge automatiquement tous les segments TS
- Les segments sont fusionnés dans le navigateur en un seul fichier `.ts`
- Prend en charge le déchiffrement automatique des **flux chiffrés AES-128**
- Affiche la progression des segments pendant le téléchargement : `45/120 segments téléchargés`

### Blob URL / vidéos MSE

- Certains sites utilisent l'API MediaSource pour la lecture (URLs commençant par `blob:`)
- L'extension intercepte et capture automatiquement ces données vidéo en mémoire
- Le téléchargement est géré via le relais Content Script

---

## 🎨 Étiquettes de type vidéo

Le panneau popup utilise des étiquettes colorées pour une identification rapide :

| Étiquette | Type | Description |
|-----------|------|-------------|
| 🟢 **MP4** | Lien direct | Téléchargement direct |
| 🔴 **HLS** | Flux M3U8 | Fusion des segments dans le navigateur puis téléchargement |
| 🟡 **DASH** | Flux MPD | Téléchargement du MPD ou fusion audio/vidéo |
| 🔴 **YouTube** | Vidéo YouTube | ≤720p direct ; 1080p+ fusion automatique |
| 🔵 **B站** | Vidéo Bilibili | Récupération via API + fusion automatique |
| 🟣 **Blob** | MSE en mémoire | Téléchargement via relais Content Script |
| ⬛ 🔒 **DRM** | Contenu chiffré | Téléchargement impossible, signalé uniquement |

---

## 📋 Formats et sites pris en charge

### Formats universels (tout site web)

| Format | Description |
|--------|-------------|
| MP4 / WebM / FLV / MKV / M4V | Lien direct, téléchargement en un clic |
| HLS (.m3u8) | Incluant le déchiffrement et la fusion des flux chiffrés AES-128 |
| DASH (.mpd) | Téléchargement du manifeste ou fusion des flux audio/vidéo |
| Blob URL | Interception des vidéos MediaSource en mémoire |

### Support spécialisé

| Site | Fonctionnalités |
|------|----------------|
| **YouTube** | Flux combinés + adaptatifs ; détection du routage SPA ; sélection multi-résolution |
| **Bilibili** | Signature WBI ; double format DASH/FLV ; vidéos multi-parties ; sélection de qualité ; injection CDN Referer |

### Limitations connues

- **Contenu chiffré DRM** (Netflix, Disney+, etc.) — La protection Widevine/PlayReady empêche l'accès aux données déchiffrées
- **Contenu payant sans connexion** — Veuillez vous connecter au site web correspondant

---

## 🏗️ Architecture

```
Chrome Extension (Manifest V3)
│
├── background/                    Service Worker
│   ├── service-worker.js          Routage des messages + surveillance des téléchargements + déclenchement de la fusion
│   ├── video-registry.js          Registre en mémoire des vidéos détectées
│   ├── request-interceptor.js     Écouteur réseau webRequest
│   ├── downloader.js              Ordonnanceur de téléchargement (MP4/HLS/DASH/YouTube/Bilibili)
│   ├── hls-fetcher.js             Téléchargement des segments HLS, déchiffrement AES, fusion en mémoire
│   └── header-injector.js         Injection d'en-têtes de requête
│
├── content/                       Content Script (accès DOM)
│   ├── content-main.js            Point d'entrée : injection des scripts + assemblage des stratégies
│   ├── message-router.js          Routage des messages popup / background / page
│   ├── progress-reporter.js       Rapport de progression des tâches dans la page
│   └── strategies/                Stratégies de téléchargement par plateforme
│
├── injected/                      Scripts de contexte de page
│   ├── page-context-script.js     Contrôleur principal
│   ├── page-interceptor.js        Hooks XHR / Fetch / MediaSource / DRM
│   ├── page-youtube-parser.js     Analyseur de flux YouTube
│   ├── page-bilibili-parser.js    Analyseur de flux Bilibili
│   └── page-http-utils.js         Utilitaires HTTP dans la page
│
├── lib/                           Bibliothèque d'utilitaires partagés
│   ├── hls-pipeline.js            Pipeline d'analyse et de traitement HLS
│   ├── mpd-parser.js              Analyseur DASH MPD
│   ├── wbi-signer.js              Algorithme de signature Bilibili WBI
│   ├── bilibili-muxer.js          Muxer FLV Bilibili
│   ├── mp4-muxer.js               Muxer MP4
│   └── ...                        Autres modules utilitaires
│
└── popup/                         Interface popup de l'extension
    ├── popup.html
    ├── popup.js
    └── popup.css
```

Pour la documentation détaillée des interfaces, voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## ❓ FAQ

<details>
<summary><strong>Aucune vidéo détectée dans le popup ?</strong></summary>

- Vérifiez que la page contient effectivement du contenu vidéo (certaines pages chargent les vidéos via des iframes, que la version actuelle n'analyse pas)
- Essayez de rafraîchir la page et de relancer la détection
- Appuyez sur F12 → Console et vérifiez s'il y a des erreurs avec le préfixe `[OVD]`

</details>

<details>
<summary><strong>YouTube ne télécharge qu'en 720p ?</strong></summary>

- Le 720p et moins correspond à des flux combinés incluant l'audio — téléchargement direct
- Le 1080p et au-delà nécessite le téléchargement séparé des flux vidéo + audio et leur fusion dans le navigateur
- Assurez-vous que votre réseau est stable ; la fusion nécessite le téléchargement complet des deux flux

</details>

<details>
<summary><strong>La fusion a échoué ?</strong></summary>

- Rafraîchissez la page et réessayez ; assurez-vous que votre réseau est stable
- Appuyez sur F12 → Console et vérifiez les journaux d'erreurs `[OVD]`
- Si seules certaines vidéos échouent, le format du flux source peut être inhabituel ou temporairement indisponible
- Le streaming YouTube / Bilibili prend en charge la relance automatique ; si le serveur supporte `Range`, la reprise est possible à partir du point d'interruption

</details>

<details>
<summary><strong>Le téléchargement Bilibili échoue ?</strong></summary>

- Assurez-vous d'être connecté à un compte Bilibili
- Si la qualité choisie n'est pas disponible, l'extension revient automatiquement à la meilleure qualité disponible
- L'algorithme de signature API de Bilibili peut changer avec les mises à jour — si les échecs persistent, veuillez ouvrir un Issue

</details>

<details>
<summary><strong>Comment lire les fichiers HLS téléchargés ?</strong></summary>

- Les fichiers `.ts` peuvent être lus directement avec VLC, PotPlayer ou mpv
- Ou convertis avec ffmpeg : `ffmpeg -i input.ts -c copy output.mp4`

</details>

---

## 🤝 Contribuer

Les Issues et Pull Requests sont les bienvenus ! Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour la configuration de l'environnement de développement et les conventions de code.

```bash
# Cloner le projet
git clone https://github.com/small-dream/OnlineVideoDownload.git

# Exécuter les tests
npm test
```

---

## 📄 Licence

Ce projet est sous licence [MIT License](LICENSE).

---

## ⚠️ Avertissement

Cet outil est destiné à un usage éducatif et personnel uniquement. Veuillez respecter les lois et règlements de votre juridiction ainsi que les conditions d'utilisation de chaque plateforme vidéo. Ne téléchargez que le contenu auquel vous avez le droit d'accéder. L'auteur n'est pas responsable de toute utilisation abusive.
