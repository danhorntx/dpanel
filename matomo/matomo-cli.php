<?php
/**
 * matomo-cli.php — internal admin operations on Matomo, bypassing HTTP auth.
 *
 * Lives inside /opt/matomo/app (mounted into the matomo-app container at
 * /var/www/html/matomo-cli.php) and invoked via `docker exec`. Uses
 * Matomo's documented Access::doAsSuperUser() so we don't need to manage
 * token_auth credentials in DPanel.
 *
 * Usage (inside matomo-app container):
 *   php /var/www/html/matomo-cli.php list-sites
 *   php /var/www/html/matomo-cli.php add-site <name> <url> [ecommerce]
 *   php /var/www/html/matomo-cli.php delete-site <idsite>
 *   php /var/www/html/matomo-cli.php exclude-ips <idsite> <ip,ip,...>
 *   php /var/www/html/matomo-cli.php exclude-urls <idsite> <regex|comma-list>
 *
 * Output is always JSON to stdout. Errors → stderr + exit 1.
 *
 * Called from DPanel's routes/matomo.js via `docker exec`.
 */

// Bootstrap Matomo exactly the way index.php does so all plugins are
// registered (we need WebsiteMeasurable's site type registration in
// particular, which a bare Environment::init() skips).
if (!defined('PIWIK_DOCUMENT_ROOT')) define('PIWIK_DOCUMENT_ROOT', '/var/www/html');
if (!defined('PIWIK_INCLUDE_PATH'))  define('PIWIK_INCLUDE_PATH',  '/var/www/html');
require_once PIWIK_INCLUDE_PATH . '/core/bootstrap.php';

use Piwik\Application\Environment;
use Piwik\Access;
use Piwik\Plugin\Manager as PluginManager;
use Piwik\Plugins\SitesManager\API as SitesManagerAPI;

$env = new Environment(null);
$env->init();

// Activate all installed plugins so type registration etc. fires. Bare
// Environment doesn't load plugins by default.
PluginManager::getInstance()->loadActivatedPlugins();

$argv = $_SERVER['argv'];
$cmd  = $argv[1] ?? '';

function out($data) { echo json_encode($data), "\n"; exit(0); }
function err($msg)  { fwrite(STDERR, "ERR: $msg\n"); exit(1); }

try {
    Access::doAsSuperUser(function () use ($argv, $cmd) {
        $sm = SitesManagerAPI::getInstance();

        switch ($cmd) {

        case 'list-sites': {
            // getAllSites() returns an associative array keyed by idsite —
            // array_values to flatten so JSON encodes as a sequential list.
            $sites = array_values($sm->getAllSites());
            $out = array_map(function ($s) {
                return [
                    'idsite'    => (int)$s['idsite'],
                    'name'      => $s['name'],
                    'main_url'  => $s['main_url'],
                    'ecommerce' => (int)($s['ecommerce'] ?? 0),
                    'created'   => $s['ts_created'] ?? null,
                ];
            }, $sites);
            out($out);
        }

        case 'add-site': {
            $name      = $argv[2] ?? err('Missing site name');
            $url       = $argv[3] ?? err('Missing site URL');
            $ecommerce = !empty($argv[4]) && $argv[4] === '1' ? 1 : 0;
            // Pass only what we actually want to set — let Matomo defaults
            // fill in everything else. Passing empty strings for null-allowed
            // fields can trip stricter validation.
            $idsite = $sm->addSite(
                $name,
                [$url],
                $ecommerce
            );
            out(['idsite' => (int)$idsite, 'name' => $name, 'url' => $url, 'ecommerce' => $ecommerce]);
        }

        case 'delete-site': {
            $idsite = (int)($argv[2] ?? 0);
            if (!$idsite) err('Missing idsite');
            $sm->deleteSite($idsite);
            out(['idsite' => $idsite, 'deleted' => true]);
        }

        case 'exclude-ips': {
            $idsite = (int)($argv[2] ?? 0);
            $ips    = $argv[3] ?? '';
            if (!$idsite) err('Missing idsite');
            $sm->updateSite($idsite, null, null, null, null, $ips);
            out(['idsite' => $idsite, 'excluded_ips' => $ips]);
        }

        case 'exclude-urls': {
            $idsite  = (int)($argv[2] ?? 0);
            $patterns = $argv[3] ?? '';
            if (!$idsite) err('Missing idsite');
            $sm->updateSite($idsite, null, null, null, null, null, $patterns);
            out(['idsite' => $idsite, 'excluded_urls' => $patterns]);
        }

        default:
            err("Unknown command: $cmd");
        }
    });
} catch (Throwable $e) {
    err($e->getMessage());
}
