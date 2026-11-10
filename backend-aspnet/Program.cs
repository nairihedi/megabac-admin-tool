// ============================================================================
// MegabacAdmin — API d'administration MegaBac (backend ASP.NET Core, IIS ou Kestrel)
//
// Sert l'interface (wwwroot = outil-admin/) et l'API /admin-api, équivalente
// à admin-api.php. Un seul compte, défini dans appsettings.json (section Admin).
//
// GET  /admin-api?action=ping                      → {"ok":true,"backend":"aspnet"}   (public)
// GET  /admin-api?action=session                   → {"authenticated":bool}           (public)
// POST /admin-api?action=login   {user,password}
// POST /admin-api?action=logout
// GET  /admin-api?action=read&path=6/matieres.json → contenu du fichier JSON
// GET  /admin-api?action=list&path=6               → [{"name":"cours","kind":"directory"},…]
// POST /admin-api?action=write&path=…              → corps = JSON complet du fichier
// POST /admin-api?action=mkdir&path=…
// POST /admin-api?action=delete&path=…&recursive=1
//
// Générer le hash du mot de passe :  dotnet run -- --hash "mon mot de passe"
// ============================================================================
using System.Collections.Concurrent;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

const int TailleMaxFichier = 16 * 1024 * 1024;
const int EssaisMax = 5;
var fenetreEssais = TimeSpan.FromMinutes(15);

// --- Utilitaire : « dotnet run -- --hash <mot de passe> » ------------------
if (args.Length == 2 && args[0] == "--hash")
{
    Console.WriteLine(Mdp.Hacher(args[1]));
    return;
}

var builder = WebApplication.CreateBuilder(args);
// Nom de cookie propre à l'installation (dossier de l'application + dossier de données) :
// deux installations sur le même hôte (autre port, autre sous-site) ne se marchent plus dessus,
// les cookies n'étant pas isolés par port.
string nomCookie = "megabac_admin_" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
    builder.Environment.ContentRootPath + "|" + (builder.Configuration["Admin:DataPath"] ?? ""))))[..8].ToLowerInvariant();
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 20 * 1024 * 1024);
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.Cookie.Name = nomCookie;
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Strict;
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        o.ExpireTimeSpan = TimeSpan.FromHours(2);
        o.SlidingExpiration = true;
        // API : pas de redirection vers une page de login, juste 401/403.
        o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
    });
builder.Services.AddAuthorization();

var app = builder.Build();

var cfg = app.Configuration.GetSection("Admin");
string dataPath = cfg["DataPath"] ?? "";
string utilisateur = cfg["Username"] ?? "";
string hashMdp = cfg["PasswordHash"] ?? "";

app.UseDefaultFiles();
// Interface : toujours revalider (ETag → 304 si inchangé). Évite qu'une ancienne version
// de app.js / style.css reste en cache après un redéploiement.
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = c => c.Context.Response.Headers["Cache-Control"] = "no-cache",
});
app.UseAuthentication();

var essais = new ConcurrentDictionary<string, List<DateTime>>();
var segmentValide = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$", RegexOptions.Compiled);

IResult Erreur(string message, int status) => Results.Json(new { error = message }, statusCode: status);

app.MapMethods("/admin-api", new[] { "GET", "POST" }, async (HttpContext ctx) =>
{
    ctx.Response.Headers["Cache-Control"] = "no-store";
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";

    string action = ctx.Request.Query["action"].ToString();
    bool post = HttpMethods.IsPost(ctx.Request.Method);

    if (action == "ping") return Results.Json(new { ok = true, backend = "aspnet" });

    if (post)
    {
        // En-tête personnalisé : impossible à envoyer depuis un site tiers sans préflight CORS (non autorisé ici).
        if (ctx.Request.Headers["X-Requested-With"] != "megabac-admin") return Erreur("Requête refusée.", 403);
        string origine = ctx.Request.Headers.Origin.ToString();
        if (origine != "" && (!Uri.TryCreate(origine, UriKind.Absolute, out var u) || !string.Equals(u.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase)))
            return Erreur("Origine refusée.", 403);
    }

    bool connecte = ctx.User.Identity?.IsAuthenticated == true;
    if (action == "session") return Results.Json(new { authenticated = connecte });

    // ---------------------------------------------------------------- login
    if (action == "login")
    {
        if (!post) return Erreur("Méthode non autorisée.", 405);
        if (utilisateur == "" || hashMdp == "") return Erreur("Configuration invalide : section Admin d'appsettings.json.", 500);

        string ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "inconnue";
        var liste = essais.GetOrAdd(ip, _ => new List<DateTime>());
        lock (liste)
        {
            liste.RemoveAll(t => t < DateTime.UtcNow - fenetreEssais);
            if (liste.Count >= EssaisMax) return Erreur("Trop de tentatives. Réessaie dans quelques minutes.", 429);
        }

        string user = "", mdp = "";
        try
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
            user = doc.RootElement.TryGetProperty("user", out var pu) ? pu.GetString() ?? "" : "";
            mdp = doc.RootElement.TryGetProperty("password", out var pp) ? pp.GetString() ?? "" : "";
        }
        catch (JsonException) { }

        // La vérification du mot de passe est faite dans tous les cas (durée constante).
        bool okMdp = Mdp.Verifier(mdp, hashMdp);
        bool okUser = CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(user), Encoding.UTF8.GetBytes(utilisateur));
        if (!(okMdp && okUser))
        {
            lock (liste) liste.Add(DateTime.UtcNow);
            await Task.Delay(1000);
            return Erreur("Identifiant ou mot de passe incorrect.", 401);
        }

        essais.TryRemove(ip, out _);
        var identite = new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, utilisateur) }, CookieAuthenticationDefaults.AuthenticationScheme);
        await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identite));
        return Results.Json(new { ok = true });
    }

    if (action == "logout")
    {
        if (!post) return Erreur("Méthode non autorisée.", 405);
        await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        return Results.Json(new { ok = true });
    }

    // ---------------------------------------- à partir d'ici : session obligatoire
    if (!connecte) return Erreur("Non authentifié.", 401);

    string racine = Path.GetFullPath(dataPath == "" ? "." : dataPath);
    if (!Directory.Exists(racine)) return Erreur("Dossier de données introuvable sur le serveur (Admin:DataPath).", 500);

    // Chemin relatif (« 6/cours/maths.json ») → segments simples uniquement, pas de « .. ».
    string relatif = (ctx.Request.Query["path"].ToString()).Replace('\\', '/').Trim('/');
    string[] segments = relatif == "" ? Array.Empty<string>() : relatif.Split('/');
    if (segments.Any(s => !segmentValide.IsMatch(s) || s.Contains("..")))
        return Erreur("Chemin invalide.", 400);
    string chemin = Path.GetFullPath(Path.Combine(new[] { racine }.Concat(segments).ToArray()));
    if (chemin != racine && !chemin.StartsWith(racine + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        return Erreur("Chemin invalide.", 400);

    bool ExigerJson() => segments.Length > 0 && segments[^1].EndsWith(".json", StringComparison.Ordinal);

    switch (action)
    {
        case "read":
            if (!ExigerJson()) return Erreur("Seuls les fichiers .json sont acceptés.", 400);
            if (!File.Exists(chemin)) return Erreur("Fichier introuvable.", 404);
            return Results.Text(await File.ReadAllTextAsync(chemin, Encoding.UTF8), "application/json; charset=utf-8");

        case "list":
            if (!Directory.Exists(chemin)) return Erreur("Dossier introuvable.", 404);
            var entrees = new DirectoryInfo(chemin).GetFileSystemInfos()
                .Select(e => new { name = e.Name, kind = e is DirectoryInfo ? "directory" : "file" });
            return Results.Json(entrees);

        case "write":
        {
            if (!post) return Erreur("Méthode non autorisée.", 405);
            if (!ExigerJson()) return Erreur("Seuls les fichiers .json sont acceptés.", 400);
            string contenu;
            using (var lecteur = new StreamReader(ctx.Request.Body, Encoding.UTF8))
                contenu = await lecteur.ReadToEndAsync();
            if (Encoding.UTF8.GetByteCount(contenu) > TailleMaxFichier) return Erreur("Fichier trop volumineux.", 413);
            try { using var _ = JsonDocument.Parse(contenu); }
            catch (JsonException) { return Erreur("JSON invalide.", 400); }

            Directory.CreateDirectory(Path.GetDirectoryName(chemin)!);
            // Écriture atomique : fichier temporaire puis remplacement.
            string temp = chemin + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
            try
            {
                await File.WriteAllTextAsync(temp, contenu, new UTF8Encoding(false));
                File.Move(temp, chemin, overwrite: true);
            }
            catch (Exception)
            {
                if (File.Exists(temp)) File.Delete(temp);
                return Erreur("Écriture impossible (droits ?).", 500);
            }
            return Results.Json(new { ok = true });
        }

        case "mkdir":
            if (!post) return Erreur("Méthode non autorisée.", 405);
            if (segments.Length == 0) return Erreur("Chemin invalide.", 400);
            Directory.CreateDirectory(chemin);
            return Results.Json(new { ok = true });

        case "delete":
            if (!post) return Erreur("Méthode non autorisée.", 405);
            if (segments.Length == 0) return Erreur("Chemin invalide.", 400); // jamais la racine
            if (Directory.Exists(chemin))
            {
                bool recursif = ctx.Request.Query["recursive"] == "1";
                try { Directory.Delete(chemin, recursif); }
                catch (IOException) { return Erreur("Dossier non vide.", 409); }
            }
            else if (File.Exists(chemin))
            {
                if (!ExigerJson()) return Erreur("Seuls les fichiers .json sont acceptés.", 400);
                File.Delete(chemin);
            }
            else return Erreur("Introuvable.", 404);
            return Results.Json(new { ok = true });

        default:
            return Erreur("Action inconnue.", 400);
    }
});

app.Run();

// ---------------------------------------------------------------------------
// Hachage du mot de passe : pbkdf2$itérations$sel(base64)$hash(base64)
// ---------------------------------------------------------------------------
static class Mdp
{
    const int Iterations = 200_000;

    public static string Hacher(string mdp)
    {
        byte[] sel = RandomNumberGenerator.GetBytes(16);
        byte[] hash = Rfc2898DeriveBytes.Pbkdf2(mdp, sel, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${Iterations}${Convert.ToBase64String(sel)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verifier(string mdp, string stocke)
    {
        var p = stocke.Split('$');
        // Hash absent ou mal formé : on fait quand même un calcul pour garder une durée comparable.
        if (p.Length != 4 || p[0] != "pbkdf2" || !int.TryParse(p[1], out int it) || it < 1)
        {
            Rfc2898DeriveBytes.Pbkdf2(mdp, new byte[16], Iterations, HashAlgorithmName.SHA256, 32);
            return false;
        }
        try
        {
            byte[] attendu = Convert.FromBase64String(p[3]);
            byte[] calcule = Rfc2898DeriveBytes.Pbkdf2(mdp, Convert.FromBase64String(p[2]), it, HashAlgorithmName.SHA256, attendu.Length);
            return CryptographicOperations.FixedTimeEquals(calcule, attendu);
        }
        catch (FormatException) { return false; }
    }
}
