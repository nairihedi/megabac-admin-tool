# Outil d'administration MegaBac — `outil-admin/`

Application web locale, sans build ni dépendance (`index.html`, `style.css`, `app.js`), pour créer/modifier/
supprimer tout le contenu (niveaux, matières, cours, exercices, épreuves)
sans écrire de JSON à la main. **Aucun serveur applicatif, aucune base de
données** : elle lit et écrit directement les fichiers du dossier
`exemple-donnees-serveur/` (ou n'importe quel dossier de même structure)
grâce à la **File System Access API** du navigateur.

## Prérequis

- **Edge ou Chrome** (la File System Access API n'est pas supportée par
  Firefox à ce jour). Les deux sont installés par défaut sous Windows.
- Servi via une URL `http://` ou `https://` — **pas** en double-cliquant sur
  le fichier (`file://` n'est pas un contexte sécurisé, la sélection de
  dossier serait refusée par le navigateur).

## Lancer l'outil

Comme pour tester `www/` (voir plus haut dans ce README) : un site IIS
pointant sur `outil-admin/`, ou plus simple pour un usage ponctuel :

```bash
cd bac-app/outil-admin
npx serve .
```

Puis ouvrir l'URL affichée dans Edge ou Chrome, cliquer sur **"Choisir le
dossier de données"** et sélectionner `exemple-donnees-serveur/`.

> La sélection de dossier n'est pas mémorisée d'une session à l'autre (pas
> de gestion utilisateur, comme demandé) : il faut la refaire à chaque
> ouverture de l'outil. C'est volontaire pour rester simple — dis-moi si tu
> préfères qu'elle soit mémorisée (possible via l'API IndexedDB, mais avec
> une popup de re-confirmation de permission à chaque lancement de toute
> façon, imposée par le navigateur pour des raisons de sécurité).

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
