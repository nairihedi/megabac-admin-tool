# Megabac Admin Tool

Outil d'administration web pour gérer le contenu pédagogique de Megabac
(niveaux, matières, cours, exercices, épreuves) sans écrire de JSON à la main.
Pas de base de données ni de build côté interface : l'outil lit et écrit
directement les fichiers JSON du dossier de données servi à l'application.

## Écosystème Megabac

| Projet | Rôle | Emplacement |
|---|---|---|
| **MegabacPwa** | Application (PWA) qui affiche le contenu | `C:\PERSO\Android\Megabac\PWA` |
| **megabac-data-server** | Données JSON servies en statique (exemple : `exemple-données-serveur/`) | `C:\PERSO\Android\Megabac\data-server` |
| **megabac-admin-tool** (ce dépôt) | Édition de ces données | ici |

Flux : l'admin écrit les JSON dans le dossier de données → le serveur de
données les sert tels quels → la PWA les télécharge si le `version.json` a changé.

## Fonctionnalités

- Gestion complète des niveaux, matières, cours, exercices et épreuves (CRUD).
- Cours : éditeur visuel (titres, gras, listes, encadré, sauts de page visibles),
  sans balises à taper ; collage depuis Word ou le web nettoyé automatiquement.
- Images affichées comme des images (bouton, glisser-déposer ou copier-coller),
  converties en WebP et réductibles (« Alléger »), intégrées en base64.
- Import d'une page de PDF dans un cours (bouton « PDF ») : en **texte modifiable**
  (titres, paragraphes, listes, gras, italique reconstitués) ou en **image** (page
  entière ou zone encadrée à la souris, pour un schéma ou une carte). Une page
  scannée, sans texte, ne peut être insérée qu'en image. Le PDF est lu dans le
  navigateur, il n'est envoyé nulle part. Limites : les tableaux sont aplatis en
  texte, les schémas et images ne sont pas repris en mode texte.
- Exercices et épreuves : même éditeur en version compacte pour les questions,
  énoncés et explications. Le texte reste dans `question` / `enonce` /
  `explication` ; dès qu'il y a une mise en forme ou une image, la variante
  `question_html` / `enonce_html` / `explication_html` est ajoutée (affichée en
  priorité par la PWA).
- Épreuves : une carte repliable par question, réordonnable (▲▼ ou glisser), duplicable.
- Protection des modifications non enregistrées (témoin, confirmation avant de quitter, Ctrl+S).
- Création automatique de l'arborescence attendue (niveau, matière, dossiers de détail).
- `version.json` incrémenté automatiquement à chaque modification, pour que
  l'application sache qu'elle doit retélécharger le contenu.
- Suppression en cascade sans fichiers orphelins ; identifiants générés automatiquement.
- Deux modes de stockage, au choix sur la page de garde :
  - **Mode local** : dossier de l'ordinateur via la File System Access API (Edge / Chrome).
  - **Mode distant** : API d'administration sur le serveur des données, avec
    compte unique protégé (session `HttpOnly`, limitation des tentatives).
    Backend **PHP** ou **ASP.NET Core**, détecté automatiquement.

## Structure

```
outil-admin/                 # à déployer tel quel (hébergement PHP ou statique)
├── index.html               # Page de garde (mode local / mode distant)
├── accueil.js               # Détection du backend (PHP / ASP.NET) pour le lien distant
├── style.css                # Styles communs
├── README-ADMIN.md          # Documentation détaillée (contrat d'API, déploiement, cache)
├── admin/                   # L'éditeur (commun aux deux modes)
│   ├── admin.html
│   ├── app.js               # Logique (CRUD, formulaires, aperçus)
│   ├── editeur.js           # Éditeur visuel (cours, questions, explications), sans dépendance
│   ├── pdf-import.js        # Import d'une page de PDF (fenêtre, conversion en texte ou en image)
│   └── remote.js            # Stockage distant (même interface que la File System Access API)
├── lib/pdfjs/               # PDF.js (Mozilla, Apache 2.0), chargée seulement au clic sur « PDF »
└── api-php/                 # Backend PHP (Apache, ou IIS + PHP)
    ├── admin-api.php
    ├── admin-config.sample.php
    ├── .htaccess
    └── web.config
backend-aspnet/              # Backend ASP.NET Core (.NET 8), sert aussi l'interface
serveur-donnees/             # Modèles web.config / .htaccess pour le serveur des DONNÉES (cache, CORS)
deployer-aspnet.ps1          # Publie la version ASP.NET Core dans un dossier (IIS)
```

## Utilisation

**Mode local** (test rapide) :

```bash
cd outil-admin
npx serve .
```

Ouvrir l'URL affichée dans Edge ou Chrome, choisir **Mode local**, puis
sélectionner le dossier de données.

**Mode distant** : déployer le backend PHP (`outil-admin/api-php/`) ou ASP.NET
Core (`backend-aspnet/`, publication via `.\deployer-aspnet.ps1`), puis renseigner
le chemin des données et le mot de passe haché. Détails, contrat d'API et
sécurité : [outil-admin/README-ADMIN.md](outil-admin/README-ADMIN.md).

**Cache** : placer la configuration de `serveur-donnees/` à la racine du serveur
des données, sinon les navigateurs peuvent ne pas voir les nouvelles versions.

## Pistes d'évolution

- Pagination des cours longs (tableau `pages` avec rétrocompatibilité sur `contenu`).
- Validation avancée du contenu, annulation (undo), import/export global.
