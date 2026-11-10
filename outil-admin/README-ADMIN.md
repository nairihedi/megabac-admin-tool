# Outil d'administration MegaBac — `outil-admin/`

Application web, sans build ni dépendance (page de garde `index.html` ; éditeur dans `admin/` ; backend PHP dans `api-php/`), pour créer/modifier/
supprimer tout le contenu (niveaux, matières, cours, exercices, épreuves)
sans écrire de JSON à la main. Aucune base de données : elle lit et écrit les fichiers JSON du dossier de
données (structure `exemple-donnees-serveur/`), de deux façons au choix sur la
page de garde (`index.html`) :

- **Mode local** : directement sur un dossier de ton ordinateur, grâce à la
  **File System Access API** du navigateur (aucun serveur applicatif).
- **Mode distant** : sur le serveur qui héberge les données, via une petite
  API d'administration protégée par un compte unique (voir plus bas). Un seul
  lien « Mode distant » : la page détecte automatiquement si le serveur
  répond en PHP ou en ASP.NET Core.

## Prérequis (mode local)

- **Edge ou Chrome** (la File System Access API n'est pas supportée par
  Firefox à ce jour). Les deux sont installés par défaut sous Windows.
- Servi via une URL `http://` ou `https://` — **pas** en double-cliquant sur
  le fichier (`file://` n'est pas un contexte sécurisé, la sélection de
  dossier serait refusée par le navigateur).

## Lancer l'outil en mode local

Comme pour tester `www/` (voir plus haut dans ce README) : un site IIS
pointant sur `outil-admin/`, ou plus simple pour un usage ponctuel :

```bash
cd bac-app/outil-admin
npx serve .
```

Puis ouvrir l'URL affichée dans Edge ou Chrome, cliquer sur **Mode local**, puis **"Choisir le
dossier de données"** et sélectionner `exemple-donnees-serveur/`.

> La sélection de dossier n'est pas mémorisée d'une session à l'autre (pas
> de gestion utilisateur, comme demandé) : il faut la refaire à chaque
> ouverture de l'outil. C'est volontaire pour rester simple — dis-moi si tu
> préfères qu'elle soit mémorisée (possible via l'API IndexedDB, mais avec
> une popup de re-confirmation de permission à chaque lancement de toute
> façon, imposée par le navigateur pour des raisons de sécurité).

## Mode distant — déploiement

L'interface est la même ; seul le stockage change (`remote.js` appelle l'API
`api-php/admin-api.php` ou `/admin-api`). Les données restent servies telles quelles
(statique) à la PWA : l'API ne sert qu'à l'administration.

Contrat de l'API (identique en PHP et en ASP.NET Core) :

| Requête | Rôle |
|---|---|
| `GET ?action=ping` | `{"ok":true,"backend":"php"\|"aspnet"}` (public, sert à la détection) |
| `GET ?action=session` | `{"authenticated":bool}` (public) |
| `POST ?action=login` `{user,password}` / `logout` | ouvre / ferme la session |
| `GET ?action=read&path=6/matieres.json` | contenu du fichier |
| `GET ?action=list&path=6` | `[{name,kind}]` |
| `POST ?action=write&path=…` (corps = JSON) | écriture atomique (crée les dossiers parents) |
| `POST ?action=mkdir&path=…` / `delete&path=…&recursive=1` | dossier / suppression |

Sécurité : compte unique, mot de passe haché, cookie de session `HttpOnly` +
`SameSite=Strict` (nom propre à l'installation, donc sans collision entre deux instances sur le même hôte), en-tête `X-Requested-With` + contrôle d'`Origin` sur les POST,
blocage après 5 échecs en 15 min par IP, chemins limités à des segments simples
(`[A-Za-z0-9._-]`, jamais `..`), fichiers `.json` uniquement, 16 Mo max.
**Mets l'outil derrière HTTPS** (sinon mot de passe et cookie circulent en clair)
et, si possible, restreins l'accès au dossier par IP.

### PHP (Apache, ou IIS + PHP ≥ 7.4)
1. Copie le dossier `outil-admin/` sur le serveur (il contient déjà `api-php/`).
2. Dans `api-php/`, copie `admin-config.sample.php` en `admin-config.php` et renseigne :
   `data_dir` (chemin absolu du dossier de données, **inscriptible** par PHP),
   `username` et `password_hash`
   (`php -r "echo password_hash('MOT_DE_PASSE', PASSWORD_DEFAULT);"`).
3. `.htaccess` (Apache) / `web.config` (IIS) bloquent déjà l'accès direct à la config.
4. Si besoin, augmenter `post_max_size` / `upload_max_filesize` (images en base64).

### ASP.NET Core (IIS, runtime .NET 8 Hosting Bundle)
1. `cd backend-aspnet && dotnet publish -c Release -o publish` : l'interface
   `outil-admin/` est copiée automatiquement dans `wwwroot`.
2. Dans `publish/appsettings.json` (ou variables d'environnement `Admin__…`) :
   `DataPath` (dossier de données, **inscriptible** par le compte du pool IIS),
   `Username`, `PasswordHash` (`dotnet run -- --hash "MOT_DE_PASSE"`).
3. Crée un site IIS pointant sur `publish/`. Test local : `dotnet run`.

Limite : à plusieurs administrateurs simultanés, le dernier enregistrement
écrase le précédent (comme en local).

## Cache du navigateur : les modifications n'apparaissent pas dans l'application

L'application ne relit un contenu que si son `version.json` a changé. Si le
serveur qui héberge les données n'envoie aucune consigne de cache, le navigateur
garde `version.json` de lui-même et ne voit jamais la nouvelle version (même après
Ctrl+F5, qui ne concerne pas les requêtes lancées ensuite par le JavaScript).

**À faire une fois sur le serveur des données** : y placer la configuration du
dossier `serveur-donnees/` (à la racine des données, à côté de `6/`, `5/`…) :
`web.config` pour IIS, `.htaccess` pour Apache. Elle impose `Cache-Control: no-cache`
(le navigateur revalide à chaque fois : réponse 304 légère si rien n'a changé) et
reprend la configuration CORS. Si un `web.config` existe déjà, fusionner les sections.

L'interface d'administration elle-même est déjà servie avec `no-cache`
(ASP.NET Core : automatique ; PHP : `.htaccess` / `web.config` à la racine de `outil-admin/`),
et l'API répond avec `Cache-Control: no-store`.

## Ce que l'outil fait pour toi automatiquement

- **Création d'un niveau** : dossier, `version.json`, `matieres.json` vide,
  et tous les sous-dossiers attendus (`cours/`, `cours-detail/`,
  `exercices/`, `exercices-detail/`, `epreuves/`, `epreuves-detail/`,
  `matieres/`).
- **Création d'une matière** : entrée dans `matieres.json`, son propre
  `matieres/{id}/version.json`, et les fichiers de listes vides
  correspondants.
- **Version bumpée automatiquement** : ajouter/modifier/supprimer un cours,
  exercice ou épreuve incrémente la version de la matière concernée ;
  ajouter/supprimer une matière incrémente la version du niveau — cohérent
  avec le cache versionné de l'application (`content.js`), qui saura donc
  qu'il doit retélécharger le contenu mis à jour.
- **Suppression en cascade propre** : supprimer une matière nettoie aussi
  les fichiers de détail (`cours-detail/`, `exercices-detail/`,
  `epreuves-detail/`) de tout ce qui lui appartenait, pas seulement les
  listes — pour ne pas laisser de fichiers orphelins.
- **Identifiants générés automatiquement** (ex: `maths-c-8f3k1`) pour cours,
  exercices, questions d'épreuve, afin d'éviter toute collision entre
  matières au sein d'un même niveau (les fichiers de détail partagent un
  seul dossier par niveau, pas un sous-dossier par matière).

## Limites connues (assumées, usage local mono-utilisateur)

- Pas d'undo — les suppressions demandent une confirmation, mais sont
  définitives.
- Pas de validation avancée du contenu (par exemple, pas de vérification
  que le HTML d'un cours est bien formé) — à relire visuellement dans l'app
  ou le site avant de considérer un contenu comme définitif.
- Un seul onglet/une seule fenêtre à la fois sur le même dossier : ouvrir
  l'outil deux fois sur les mêmes fichiers en parallèle peut faire perdre
  des modifications (le dernier enregistrement écrase le précédent).
