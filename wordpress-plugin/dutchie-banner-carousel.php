<?php
/**
 * Plugin Name: Dutchie Banner Carousel
 * Plugin URI: https://github.com/Deenyoro/Dutchie-Banner-API
 * Description: Display promotional banners from your Dutchie menu as an auto-rotating carousel. Features: API-powered, cached for performance, auto-refresh every 30 minutes, comprehensive debug logging, and zero frontend API calls for fast page loads.
 * Version: 4.0.0
 * Author: KawaConnect LLC
 * Author URI: https://kawaconnect.com
 * License: MIT
 * Requires at least: 5.0
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) exit;

class DutchieBannerCarousel {

    const OPTION_NAME = 'dutchie_banner_settings';
    const CACHE_KEY = 'dutchie_banners_v3';
    const ERROR_KEY = 'dutchie_last_error';
    const CACHE_TIME = 1800; // 30 minutes

    public function __construct() {
        add_action('admin_menu', array($this, 'add_admin_menu'));
        add_action('admin_init', array($this, 'register_settings'));
        add_shortcode('dutchie_banners', array($this, 'shortcode_banners'));
        add_action('wp_ajax_dutchie_test', array($this, 'ajax_test'));
        add_action('wp_ajax_dutchie_refresh', array($this, 'ajax_refresh'));
        add_action('wp_head', array($this, 'output_styles'));

        // Auto-refresh cron
        add_action('dutchie_cron_refresh', array($this, 'cron_refresh'));
        if (!wp_next_scheduled('dutchie_cron_refresh')) {
            wp_schedule_event(time(), 'thirty_minutes', 'dutchie_cron_refresh');
        }
        add_filter('cron_schedules', array($this, 'add_cron_interval'));
    }

    public function add_cron_interval($schedules) {
        $schedules['thirty_minutes'] = array(
            'interval' => 1800,
            'display' => 'Every 30 Minutes'
        );
        return $schedules;
    }

    public function cron_refresh() {
        $result = $this->fetch_api();
        if (!is_wp_error($result)) {
            set_transient(self::CACHE_KEY, $result, self::CACHE_TIME);
            delete_option(self::ERROR_KEY);
        } else {
            update_option(self::ERROR_KEY, $result->get_error_message());
        }
    }

    public function add_admin_menu() {
        add_options_page('Dutchie Banners', 'Dutchie Banners', 'manage_options', 'dutchie_banners', array($this, 'admin_page'));
    }

    public function register_settings() {
        register_setting('dutchie_opts', self::OPTION_NAME);
    }

    public function admin_page() {
        $opts = get_option(self::OPTION_NAME, array());
        $url = isset($opts['api_url']) ? $opts['api_url'] : '';
        $key = isset($opts['api_key']) ? $opts['api_key'] : '';
        $cached = get_transient(self::CACHE_KEY);
        $error = get_option(self::ERROR_KEY, '');
        ?>
        <div class="wrap">
            <h1>Dutchie Banner Carousel</h1>
            <p>Display promotional banners from your Dutchie menu. Powered by <a href="https://github.com/Deenyoro/Dutchie-Banner-API" target="_blank">Dutchie Banner API</a>.</p>

            <form method="post" action="options.php">
                <?php settings_fields('dutchie_opts'); ?>
                <table class="form-table">
                    <tr>
                        <th>API URL</th>
                        <td>
                            <input type="text" name="<?php echo self::OPTION_NAME; ?>[api_url]" value="<?php echo esc_attr($url); ?>" class="regular-text" placeholder="https://your-api-domain.com">
                            <p class="description">The URL of your Dutchie Banner API server (without trailing slash).</p>
                        </td>
                    </tr>
                    <tr>
                        <th>API Key</th>
                        <td>
                            <input type="text" name="<?php echo self::OPTION_NAME; ?>[api_key]" value="<?php echo esc_attr($key); ?>" class="regular-text" placeholder="Your API key">
                            <p class="description">The API key configured in your Dutchie Banner API .env file.</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>

            <hr>
            <h2>Connection Status</h2>
            <?php if ($cached && is_array($cached)): ?>
                <p style="color:green;font-weight:bold;">&#10003; Connected - <?php echo count($cached); ?> banners cached</p>
            <?php elseif ($error): ?>
                <p style="color:red;font-weight:bold;">&#10007; Error: <?php echo esc_html($error); ?></p>
            <?php else: ?>
                <p style="color:orange;">&#9888; No banners cached yet. Click "Refresh Banners Now" below.</p>
            <?php endif; ?>

            <p>
                <button type="button" class="button button-primary" onclick="dutchieRefresh()">Refresh Banners Now</button>
                <button type="button" class="button" onclick="dutchieTest()">Test Connection</button>
            </p>
            <div id="result"></div>

            <hr>
            <h2>Usage</h2>
            <p>Add this shortcode to any page, post, or widget to display the banner carousel:</p>
            <p><code>[dutchie_banners]</code></p>

            <hr>
            <h2>Debug Log</h2>
            <p><em>Click "Test Connection" to generate a new debug log with detailed diagnostic information.</em></p>
            <pre style="background:#1e1e1e;color:#d4d4d4;padding:15px;font-size:12px;font-family:monospace;overflow-x:auto;max-height:400px;overflow-y:auto;border-radius:4px;"><?php echo esc_html($this->get_debug_log()); ?></pre>

            <hr>
            <h2>Quick Reference</h2>
            <table class="widefat" style="max-width:600px;">
                <tr><th style="width:150px;">Shortcode</th><td><code>[dutchie_banners]</code></td></tr>
                <tr><th>Cache Status</th><td><?php echo $cached ? '<span style="color:green;">Valid (' . count($cached) . ' banners)</span>' : '<span style="color:orange;">Empty</span>'; ?></td></tr>
                <tr><th>Auto-refresh</th><td>Every 30 minutes via WP-Cron</td></tr>
                <tr><th>Cache Duration</th><td>30 minutes</td></tr>
                <?php if ($url && $key): ?>
                <tr><th>Test with curl</th><td><code style="font-size:10px;word-break:break-all;">curl "<?php echo esc_html(rtrim($url, '/') . '/api/banners?key=' . $key); ?>"</code></td></tr>
                <?php endif; ?>
            </table>

            <hr>
            <h2>Troubleshooting</h2>
            <ul style="list-style:disc;margin-left:20px;">
                <li><strong>403 Forbidden with "Just a moment..."</strong> - Cloudflare is blocking the request. Disable Bot Fight Mode or add a Configuration Rule.</li>
                <li><strong>Connection timeout</strong> - Check if the API server is running and accessible from this WordPress server.</li>
                <li><strong>Invalid API key</strong> - Verify the API key matches the one in your API server's .env file.</li>
                <li><strong>No banners showing</strong> - Click "Refresh Banners Now" to populate the cache.</li>
            </ul>
        </div>
        <script>
        function dutchieTest() {
            document.getElementById('result').innerHTML = '<p>Testing connection...</p>';
            jQuery.post(ajaxurl, {action:'dutchie_test'}, function(r){
                document.getElementById('result').innerHTML = '<p style="color:'+(r.success?'green':'red')+';font-weight:bold;">'+r.data+'</p>';
                setTimeout(function(){location.reload();}, 2000);
            });
        }
        function dutchieRefresh() {
            document.getElementById('result').innerHTML = '<p>Refreshing banners...</p>';
            jQuery.post(ajaxurl, {action:'dutchie_refresh'}, function(r){
                document.getElementById('result').innerHTML = '<p style="color:'+(r.success?'green':'red')+';font-weight:bold;">'+r.data+'</p>';
                if(r.success) setTimeout(function(){location.reload();}, 1500);
            });
        }
        </script>
        <?php
    }

    public function ajax_test() {
        if (!current_user_can('manage_options')) wp_send_json_error('Unauthorized');
        $result = $this->fetch_api();
        if (is_wp_error($result)) {
            wp_send_json_error($result->get_error_message());
        }
        wp_send_json_success('Connection successful! Found ' . count($result) . ' banners.');
    }

    public function ajax_refresh() {
        if (!current_user_can('manage_options')) wp_send_json_error('Unauthorized');
        delete_transient(self::CACHE_KEY);
        delete_option(self::ERROR_KEY);
        $result = $this->fetch_api();
        if (is_wp_error($result)) {
            update_option(self::ERROR_KEY, $result->get_error_message());
            wp_send_json_error($result->get_error_message());
        }
        set_transient(self::CACHE_KEY, $result, self::CACHE_TIME);
        wp_send_json_success('Successfully cached ' . count($result) . ' banners!');
    }

    private function fetch_api($debug = false) {
        $log = array();
        $log[] = '=== Dutchie Banner API Debug Log ===';
        $log[] = 'Generated: ' . current_time('Y-m-d H:i:s T');
        $log[] = 'PHP Version: ' . phpversion();
        $log[] = 'WordPress Version: ' . get_bloginfo('version');
        $log[] = 'Site URL: ' . get_site_url();
        $log[] = 'Server IP: ' . (isset($_SERVER['SERVER_ADDR']) ? $_SERVER['SERVER_ADDR'] : 'Unknown');
        $log[] = '';

        $opts = get_option(self::OPTION_NAME, array());
        $url = isset($opts['api_url']) ? trim($opts['api_url']) : '';
        $key = isset($opts['api_key']) ? trim($opts['api_key']) : '';

        $log[] = '--- Configuration ---';
        $log[] = 'API URL: ' . ($url ? $url : '(not configured)');
        $log[] = 'API Key: ' . ($key ? 'Configured (' . strlen($key) . ' characters)' : '(not configured)');

        if (!$url || !$key) {
            $log[] = '';
            $log[] = 'ERROR: API URL and API Key are both required.';
            $log[] = 'Please configure these settings above and save.';
            $this->save_debug_log($log);
            return new WP_Error('cfg', 'API URL and Key required');
        }

        $endpoint = rtrim($url, '/') . '/api/banners?key=' . urlencode($key);
        $log[] = '';
        $log[] = '--- HTTP Request ---';
        $log[] = 'Endpoint: ' . preg_replace('/key=[^&]+/', 'key=***REDACTED***', $endpoint);
        $log[] = 'Method: GET';
        $log[] = 'Timeout: 15 seconds';
        $log[] = 'SSL Verification: Enabled';
        $log[] = 'Follow Redirects: Disabled (to detect Cloudflare issues)';

        $start_time = microtime(true);

        $resp = wp_remote_get($endpoint, array(
            'timeout' => 15,
            'sslverify' => true,
            'redirection' => 0,
            'headers' => array(
                'Accept' => 'application/json',
                'User-Agent' => 'DutchieBannerCarousel/4.0.0 WordPress/' . get_bloginfo('version')
            )
        ));

        $elapsed = round((microtime(true) - $start_time) * 1000);
        $log[] = 'Response Time: ' . $elapsed . 'ms';
        $log[] = '';

        $log[] = '--- HTTP Response ---';

        if (is_wp_error($resp)) {
            $log[] = 'Status: WordPress Error';
            $log[] = 'Error Code: ' . $resp->get_error_code();
            $log[] = 'Error Message: ' . $resp->get_error_message();
            $log[] = '';
            $log[] = '--- Diagnosis ---';
            $log[] = 'WordPress was unable to connect to the API server.';
            $log[] = '';
            $log[] = 'Possible causes:';
            $log[] = '  1. API server is not running or unreachable';
            $log[] = '  2. DNS cannot resolve the hostname';
            $log[] = '  3. Firewall blocking outbound connections on port 443';
            $log[] = '  4. SSL certificate issue on API server';
            $log[] = '  5. Network connectivity problem';
            $log[] = '';
            $log[] = 'Recommended actions:';
            $log[] = '  - Verify the API URL is correct';
            $log[] = '  - Test from server: curl "' . preg_replace('/key=[^&]+/', 'key=YOUR_KEY', $endpoint) . '"';
            $log[] = '  - Check if API server is running: docker ps';
            $this->save_debug_log($log);
            return new WP_Error('net', 'Connection failed: ' . $resp->get_error_message() . ' [' . $elapsed . 'ms]');
        }

        $code = wp_remote_retrieve_response_code($resp);
        $body = wp_remote_retrieve_body($resp);
        $headers = wp_remote_retrieve_headers($resp);

        $log[] = 'HTTP Status Code: ' . $code;
        $log[] = 'Response Size: ' . strlen($body) . ' bytes';
        $log[] = '';
        $log[] = '--- Response Headers ---';
        foreach ($headers as $name => $value) {
            if (is_array($value)) {
                $log[] = $name . ': ' . implode(', ', $value);
            } else {
                $log[] = $name . ': ' . $value;
            }
        }
        $log[] = '';
        $log[] = '--- Response Body (first 500 characters) ---';
        $log[] = substr($body, 0, 500);
        if (strlen($body) > 500) {
            $log[] = '... (truncated, ' . (strlen($body) - 500) . ' more bytes)';
        }
        $log[] = '';

        if ($code === 302 || $code === 301) {
            $location = wp_remote_retrieve_header($resp, 'location');
            $log[] = '--- Diagnosis ---';
            $log[] = 'Status: REDIRECT DETECTED';
            $log[] = 'Redirect Location: ' . $location;
            $log[] = '';
            if (strpos($location, 'cloudflareaccess.com') !== false || strpos($body, 'Cloudflare') !== false) {
                $log[] = '*** CLOUDFLARE ACCESS IS BLOCKING THIS REQUEST ***';
                $log[] = '';
                $log[] = 'The API is protected by Cloudflare Access, which requires authentication.';
                $log[] = '';
                $log[] = 'Solution:';
                $log[] = '  1. Go to Cloudflare Zero Trust Dashboard';
                $log[] = '  2. Navigate to Access > Applications';
                $log[] = '  3. Delete the Access Application for your API hostname';
                $log[] = '  4. The API will still be protected by your API key';
            }
            $this->save_debug_log($log);
            return new WP_Error('redirect', "HTTP $code redirect to: $location");
        }

        if ($code === 403) {
            $log[] = '--- Diagnosis ---';
            $log[] = 'Status: 403 FORBIDDEN';
            $log[] = '';
            if (strpos($body, 'Just a moment') !== false || strpos($body, 'Cloudflare') !== false || isset($headers['cf-mitigated'])) {
                $log[] = '*** CLOUDFLARE BOT PROTECTION IS BLOCKING THIS REQUEST ***';
                $log[] = '';
                $log[] = 'Cloudflare is challenging this request because it appears automated.';
                $log[] = '';
                $log[] = 'Solutions (try in order):';
                $log[] = '  1. Disable Bot Fight Mode:';
                $log[] = '     Cloudflare Dashboard > Security > Bots > Turn OFF Bot Fight Mode';
                $log[] = '';
                $log[] = '  2. Create a Configuration Rule:';
                $log[] = '     Cloudflare Dashboard > Rules > Configuration Rules';
                $log[] = '     - Field: Hostname';
                $log[] = '     - Operator: equals';
                $log[] = '     - Value: (your API hostname)';
                $log[] = '     - Then: Browser Integrity Check = OFF';
                $log[] = '';
                $log[] = '  3. Whitelist WordPress server IP in Cloudflare';
            } else {
                $log[] = 'The API rejected this request.';
                $log[] = '';
                $log[] = 'Possible causes:';
                $log[] = '  - Invalid API key';
                $log[] = '  - API key has been regenerated';
                $log[] = '';
                $log[] = 'Solution: Verify the API key matches the one in your API .env file';
            }
            $this->save_debug_log($log);
            return new WP_Error('forbidden', "HTTP 403: Access denied. Check debug log for details.");
        }

        if ($code === 401) {
            $log[] = '--- Diagnosis ---';
            $log[] = 'Status: 401 UNAUTHORIZED';
            $log[] = '';
            $log[] = 'The API key is missing or invalid.';
            $log[] = '';
            $log[] = 'Solution: Check that the API key exactly matches the one in your API .env file.';
            $this->save_debug_log($log);
            return new WP_Error('unauthorized', "HTTP 401: Invalid or missing API key");
        }

        if ($code !== 200) {
            $preview = substr(strip_tags($body), 0, 200);
            $log[] = '--- Diagnosis ---';
            $log[] = 'Status: UNEXPECTED HTTP STATUS';
            $log[] = '';
            $log[] = 'Expected HTTP 200, received HTTP ' . $code;
            $log[] = 'This may indicate a server error or misconfiguration.';
            $this->save_debug_log($log);
            return new WP_Error('http', "HTTP $code: $preview");
        }

        $log[] = '--- JSON Parsing ---';
        $data = json_decode($body, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            $log[] = 'Status: JSON PARSE ERROR';
            $log[] = 'Error: ' . json_last_error_msg();
            $log[] = '';
            $log[] = 'The API returned a response that is not valid JSON.';
            $log[] = 'This may indicate the API is returning an error page.';
            $this->save_debug_log($log);
            return new WP_Error('json', 'Invalid JSON response: ' . json_last_error_msg());
        }

        if (!$data || !isset($data['banners'])) {
            $log[] = 'Status: INVALID RESPONSE STRUCTURE';
            $log[] = 'Expected key "banners" not found in response.';
            $log[] = 'Keys present: ' . implode(', ', array_keys($data ?: array()));
            $this->save_debug_log($log);
            return new WP_Error('json', 'Invalid response: missing banners array');
        }

        $count = count($data['banners']);
        $log[] = 'Status: SUCCESS';
        $log[] = 'Banners found: ' . $count;
        $log[] = '';
        $log[] = '=== CONNECTION SUCCESSFUL ===';
        $log[] = 'Retrieved ' . $count . ' banners from the API.';
        $log[] = 'Banners will be cached for 30 minutes.';
        $this->save_debug_log($log);

        return $data['banners'];
    }

    private function save_debug_log($log) {
        update_option(self::ERROR_KEY . '_debug', implode("\n", $log));
    }

    private function get_debug_log() {
        return get_option(self::ERROR_KEY . '_debug', 'No debug log available yet. Click "Test Connection" to generate one.');
    }

    /**
     * Shortcode handler - displays the banner carousel
     *
     * IMPORTANT: This method ONLY reads from cache and NEVER makes API calls.
     * This ensures the shortcode never blocks or slows down page rendering.
     * Banners are refreshed via WP-Cron or manually from the admin panel.
     */
    public function shortcode_banners($atts) {
        $banners = get_transient(self::CACHE_KEY);

        if (!$banners || !is_array($banners) || empty($banners)) {
            return '<!-- Dutchie Banner Carousel: No banners cached. Visit Settings > Dutchie Banners to refresh. -->';
        }

        $id = 'dc' . wp_rand(100, 999);
        $out = '<div class="dutchie-carousel" id="' . $id . '">';
        $out .= '<div class="dutchie-track">';

        foreach ($banners as $b) {
            $out .= '<div class="dutchie-slide">';
            if (!empty($b['link'])) $out .= '<a href="' . esc_url($b['link']) . '" target="_blank" rel="noopener">';
            $out .= '<img src="' . esc_url($b['src']) . '" alt="' . esc_attr($b['alt'] ?? '') . '" loading="lazy">';
            if (!empty($b['link'])) $out .= '</a>';
            $out .= '</div>';
        }

        $out .= '</div>';
        $out .= '<button class="dutchie-prev" aria-label="Previous slide">&#10094;</button>';
        $out .= '<button class="dutchie-next" aria-label="Next slide">&#10095;</button>';
        $out .= '<div class="dutchie-dots">';
        for ($i = 0; $i < count($banners); $i++) {
            $out .= '<span class="dutchie-dot' . ($i === 0 ? ' active' : '') . '" aria-label="Go to slide ' . ($i + 1) . '"></span>';
        }
        $out .= '</div></div>';

        $out .= '<script>(function(){var c=document.getElementById("' . $id . '"),t=c.querySelector(".dutchie-track"),n=' . count($banners) . ',i=0;function go(x){i=((x%n)+n)%n;t.style.transform="translateX(-"+(i*100)+"%)";c.querySelectorAll(".dutchie-dot").forEach(function(d,j){d.className="dutchie-dot"+(j===i?" active":"")});}c.querySelector(".dutchie-prev").onclick=function(){go(i-1)};c.querySelector(".dutchie-next").onclick=function(){go(i+1)};c.querySelectorAll(".dutchie-dot").forEach(function(d,j){d.onclick=function(){go(j)}});setInterval(function(){go(i+1)},5000)})();</script>';

        return $out;
    }

    /**
     * Output carousel styles in the page head
     */
    public function output_styles() {
        echo '<style>
.dutchie-carousel{position:relative;overflow:hidden;border-radius:8px;max-width:100%}
.dutchie-track{display:flex;transition:transform .4s ease}
.dutchie-slide{min-width:100%;flex-shrink:0}
.dutchie-slide img{width:100%;height:auto;display:block}
.dutchie-slide a{display:block}
.dutchie-prev,.dutchie-next{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);color:#fff;border:none;padding:12px 8px;cursor:pointer;font-size:16px;z-index:10;transition:background .2s}
.dutchie-prev{left:0;border-radius:0 4px 4px 0}
.dutchie-next{right:0;border-radius:4px 0 0 4px}
.dutchie-prev:hover,.dutchie-next:hover{background:rgba(0,0,0,.8)}
.dutchie-dots{text-align:center;padding:8px}
.dutchie-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ccc;margin:0 4px;cursor:pointer;transition:background .2s}
.dutchie-dot.active{background:#333}
</style>';
    }
}

new DutchieBannerCarousel();
