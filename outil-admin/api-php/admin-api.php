<?php
// ============================================================================
// admin-api.php — API d'administration MegaBac (backend PHP, Apache ou IIS+PHP)
//
// Permet à l'outil d'admin (admin.html, mode distant) de lire/écrire les
// fichiers JSON du dossier de données hébergé sur ce serveur. Un seul compte,
// défini dans admin-config.php (voir admin-config.sample.php).
//
// GET  ?action=ping                      → {"ok":true,"backend":"php"}   (public)
// GET  ?action=session                   → {"authenticated":bool}        (public)
// POST ?action=login   {user,password}   → ouvre la session
// POST ?action=logout
// GET  ?action=read&path=6/matieres.json → contenu du fichier JSON
// GET  ?action=list&path=6               → [{"name":"cours","kind":"directory"},…]
// POST ?action=write&path=…              → corps = JSON complet du fichier
// POST ?action=mkdir&path=…
// POST ?action=delete&path=…&recursive=1
// ============================================================================
declare(strict_types=1);

const TAILLE_MAX_FICHIER = 16 * 1024 * 1024; // 16 Mo
const ESSAIS_MAX = 5;                         // échecs de connexion tolérés…
const FENETRE_ESSAIS = 900;                   // …par IP, sur 15 minutes

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function repondre($donnees, int $status = 200): void {
    http_response_code($status);
    echo json_encode($donnees, JSON_UNESCAPED_UNICODE);
    exit;
}
function erreur(string $message, int $status): void {
    repondre(['error' => $message], $status);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
$action = $_GET['action'] ?? '';

if ($action === 'ping') {
    repondre(['ok' => true, 'backend' => 'php']);
}

$fichierConfig = __DIR__ . '/admin-config.php';
if (!is_file($fichierConfig)) {
    erreur("Configuration absente : copie admin-config.sample.php en admin-config.php.", 500);
}
$config = require $fichierConfig;
foreach (['data_dir', 'username', 'password_hash'] as $cle) {
    if (empty($config[$cle]) || !is_string($config[$cle])) {
        erreur("Configuration invalide : « $cle » manquant dans admin-config.php.", 500);
    }
}

// ---------------------------------------------------------------------------
// Session (cookie HttpOnly + SameSite=Strict) et protection CSRF
// ---------------------------------------------------------------------------
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || ($_SERVER['SERVER_PORT'] ?? '') == 443;
session_name('megabac_admin');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => $https,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();
$connecte = ($_SESSION['admin'] ?? false) === true;
// Expiration par inactivité (2 h).
if ($connecte && time() - ($_SESSION['derniere_activite'] ?? 0) > 7200) {
    $_SESSION = [];
    $connecte = false;
}
if ($connecte) {
    $_SESSION['derniere_activite'] = time();
}

$methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($methode === 'POST') {
    // En-tête personnalisé : un site tiers ne peut pas l'envoyer sans préflight CORS (refusé ici).
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'megabac-admin') {
        erreur('Requête refusée.', 403);
    }
    $origine = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origine !== '' && parse_url($origine, PHP_URL_HOST) !== parse_url('//' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST)) {
        erreur('Origine refusée.', 403);
    }
}

if ($action === 'session') {
    session_write_close();
    repondre(['authenticated' => $connecte]);
}

// ---------------------------------------------------------------------------
// Connexion / déconnexion
// ---------------------------------------------------------------------------
if ($action === 'login') {
    if ($methode !== 'POST') erreur('Méthode non autorisée.', 405);

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'inconnue';
    $fichierEssais = sys_get_temp_dir() . '/megabac_admin_essais_' . hash('sha256', $ip) . '.json';
    $essais = is_file($fichierEssais) ? (json_decode((string)file_get_contents($fichierEssais), true) ?: []) : [];
    $essais = array_values(array_filter($essais, fn($t) => $t > time() - FENETRE_ESSAIS));
    if (count($essais) >= ESSAIS_MAX) {
        erreur('Trop de tentatives. Réessaie dans quelques minutes.', 429);
    }

    $corps = json_decode((string)file_get_contents('php://input'), true);
    $user = is_array($corps) ? (string)($corps['user'] ?? '') : '';
    $mdp = is_array($corps) ? (string)($corps['password'] ?? '') : '';

    // password_verify est exécuté dans tous les cas (pas de différence de durée selon l'identifiant).
    $okMdp = password_verify($mdp, $config['password_hash']);
    $okUser = hash_equals($config['username'], $user);
    if (!($okMdp && $okUser)) {
        $essais[] = time();
        file_put_contents($fichierEssais, json_encode($essais), LOCK_EX);
        sleep(1);
        erreur('Identifiant ou mot de passe incorrect.', 401);
    }

    @unlink($fichierEssais);
    session_regenerate_id(true);
    $_SESSION['admin'] = true;
    $_SESSION['derniere_activite'] = time();
    repondre(['ok' => true]);
}

if ($action === 'logout') {
    if ($methode !== 'POST') erreur('Méthode non autorisée.', 405);
    $_SESSION = [];
    session_destroy();
    repondre(['ok' => true]);
}

// ---------------------------------------------------------------------------
// À partir d'ici : session ouverte obligatoire
// ---------------------------------------------------------------------------
session_write_close();
if (!$connecte) {
    erreur('Non authentifié.', 401);
}

$racine = realpath($config['data_dir']);
if ($racine === false || !is_dir($racine)) {
    erreur('Dossier de données introuvable sur le serveur (data_dir).', 500);
}

// Valide un chemin relatif (« 6/cours/maths.json ») et renvoie son chemin absolu.
// Seuls des segments simples sont acceptés : pas de « .. », pas de caractères spéciaux.
function resoudre_chemin(string $racine, string $relatif): array {
    $relatif = trim(str_replace('\\', '/', $relatif), '/');
    $segments = $relatif === '' ? [] : explode('/', $relatif);
    foreach ($segments as $s) {
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/', $s) || strpos($s, '..') !== false) {
            erreur('Chemin invalide.', 400);
        }
    }
    return [$segments, $racine . ($segments ? DIRECTORY_SEPARATOR . implode(DIRECTORY_SEPARATOR, $segments) : '')];
}
function exiger_json(array $segments): void {
    if (!$segments || !preg_match('/\.json$/', end($segments))) {
        erreur('Seuls les fichiers .json sont acceptés.', 400);
    }
}
// Vérifie qu'un chemin existant reste bien dans le dossier de données (liens symboliques).
function dans_racine(string $racine, string $chemin): bool {
    $reel = realpath($chemin);
    return $reel !== false && ($reel === $racine || strpos($reel, $racine . DIRECTORY_SEPARATOR) === 0);
}
function supprimer_recursif(string $chemin): void {
    if (is_link($chemin) || is_file($chemin)) { unlink($chemin); return; }
    foreach (scandir($chemin) as $nom) {
        if ($nom === '.' || $nom === '..') continue;
        supprimer_recursif($chemin . DIRECTORY_SEPARATOR . $nom);
    }
    rmdir($chemin);
}

[$segments, $chemin] = resoudre_chemin($racine, (string)($_GET['path'] ?? ''));

switch ($action) {
    case 'read':
        exiger_json($segments);
        if (!is_file($chemin) || !dans_racine($racine, $chemin)) erreur('Fichier introuvable.', 404);
        echo file_get_contents($chemin);
        exit;

    case 'list':
        if (!is_dir($chemin) || !dans_racine($racine, $chemin)) erreur('Dossier introuvable.', 404);
        $liste = [];
        foreach (scandir($chemin) as $nom) {
            if ($nom === '.' || $nom === '..') continue;
            $liste[] = ['name' => $nom, 'kind' => is_dir($chemin . DIRECTORY_SEPARATOR . $nom) ? 'directory' : 'file'];
        }
        repondre($liste);

    case 'write':
        if ($methode !== 'POST') erreur('Méthode non autorisée.', 405);
        exiger_json($segments);
        $contenu = (string)file_get_contents('php://input');
        if (strlen($contenu) > TAILLE_MAX_FICHIER) erreur('Fichier trop volumineux.', 413);
        json_decode($contenu);
        if (json_last_error() !== JSON_ERROR_NONE) erreur('JSON invalide.', 400);

        $dossier = dirname($chemin);
        if (!is_dir($dossier) && !mkdir($dossier, 0775, true) && !is_dir($dossier)) {
            erreur('Création du dossier impossible.', 500);
        }
        if (!dans_racine($racine, $dossier)) erreur('Chemin invalide.', 400);
        // Écriture atomique : fichier temporaire puis renommage.
        $temp = $chemin . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (file_put_contents($temp, $contenu, LOCK_EX) === false) erreur('Écriture impossible (droits ?).', 500);
        if (!rename($temp, $chemin)) {
            @unlink($temp);
            erreur('Écriture impossible (renommage).', 500);
        }
        repondre(['ok' => true]);

    case 'mkdir':
        if ($methode !== 'POST') erreur('Méthode non autorisée.', 405);
        if (!$segments) erreur('Chemin invalide.', 400);
        if (!is_dir($chemin) && !mkdir($chemin, 0775, true) && !is_dir($chemin)) {
            erreur('Création du dossier impossible.', 500);
        }
        if (!dans_racine($racine, $chemin)) erreur('Chemin invalide.', 400);
        repondre(['ok' => true]);

    case 'delete':
        if ($methode !== 'POST') erreur('Méthode non autorisée.', 405);
        if (!$segments) erreur('Chemin invalide.', 400); // jamais la racine
        if (!file_exists($chemin) || !dans_racine($racine, $chemin)) erreur('Introuvable.', 404);
        if (is_dir($chemin)) {
            if (($_GET['recursive'] ?? '0') === '1') supprimer_recursif($chemin);
            elseif (!rmdir($chemin)) erreur('Dossier non vide.', 409);
        } else {
            exiger_json($segments);
            unlink($chemin);
        }
        repondre(['ok' => true]);

    default:
        erreur('Action inconnue.', 400);
}
