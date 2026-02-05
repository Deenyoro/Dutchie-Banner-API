<?php
/**
 * Plugin Name: Dutchie Banner Carousel
 * Plugin URI: https://github.com/Deenyoro/Dutchie-Banner-API
 * Description: Display promotional banners from your Dutchie menu as an auto-rotating carousel. Features: API-powered, cached for performance, auto-refresh, touch/swipe support, custom CSS, custom templates, and multiple output formats.
 * Version: 5.2.0
 * Author: KawaConnect LLC
 * Author URI: https://kawaconnect.com
 * License: MIT
 * Requires at least: 5.0
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) exit;

class DutchieBannerCarousel {

    const OPTION_NAME = 'dutchie_banner_settings';
    const CACHE_KEY = 'dutchie_banners_v4';
    const REFRESH_TIME_KEY = 'dutchie_last_refresh';
    const ERROR_KEY = 'dutchie_last_error';
    const CACHE_TIME = 1800;

    public function __construct() {
        add_action('admin_menu', array($this, 'add_admin_menu'));
        add_action('admin_init', array($this, 'register_settings'));
        add_shortcode('dutchie_banners', array($this, 'shortcode_banners'));
        add_shortcode('dutchie_custom', array($this, 'shortcode_custom'));
        add_action('wp_ajax_dutchie_test', array($this, 'ajax_test'));
        add_action('wp_ajax_dutchie_refresh', array($this, 'ajax_refresh'));
        add_action('wp_ajax_nopriv_dutchie_bg_refresh', array($this, 'ajax_bg_refresh'));
        add_action('wp_ajax_dutchie_bg_refresh', array($this, 'ajax_bg_refresh'));
        add_action('wp_head', array($this, 'output_styles'));
        add_action('wp_footer', array($this, 'maybe_trigger_refresh'));
        add_action('init', array($this, 'check_staleness'));

        add_action('dutchie_cron_refresh', array($this, 'cron_refresh'));
        if (!wp_next_scheduled('dutchie_cron_refresh')) {
            wp_schedule_event(time(), 'fifteen_minutes', 'dutchie_cron_refresh');
        }
        add_filter('cron_schedules', array($this, 'add_cron_interval'));
    }

    public function add_cron_interval($schedules) {
        $schedules['fifteen_minutes'] = array('interval' => 900, 'display' => 'Every 15 Minutes');
        $schedules['thirty_minutes'] = array('interval' => 1800, 'display' => 'Every 30 Minutes');
        return $schedules;
    }

    public function check_staleness() {
        $opts = get_option(self::OPTION_NAME, array());
        if (empty($opts['api_url']) || empty($opts['api_key'])) return;
        $last_refresh = get_option(self::REFRESH_TIME_KEY, 0);
        if ((time() - $last_refresh) > 2700) {
            $this->trigger_async_refresh();
        }
    }

    private function trigger_async_refresh() {
        if (get_transient('dutchie_refresh_lock')) return;
        wp_remote_post(admin_url('admin-ajax.php'), array(
            'timeout' => 0.01, 'blocking' => false,
            'body' => array('action' => 'dutchie_bg_refresh'), 'sslverify' => false
        ));
    }

    public function cron_refresh() {
        $result = $this->fetch_api();
        if (!is_wp_error($result)) {
            set_transient(self::CACHE_KEY, $result, self::CACHE_TIME);
            update_option(self::REFRESH_TIME_KEY, time());
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
        $custom_css = isset($opts['custom_css']) ? $opts['custom_css'] : '';
        $custom_template = isset($opts['custom_template']) ? $opts['custom_template'] : '';
        $cached = get_transient(self::CACHE_KEY);
        $error = get_option(self::ERROR_KEY, '');
        $last_refresh = get_option(self::REFRESH_TIME_KEY, 0);
        $age_minutes = $last_refresh ? round((time() - $last_refresh) / 60) : null;
        ?>
        <div class="wrap">
            <h1>Dutchie Banner Carousel</h1>
            <form method="post" action="options.php">
                <?php settings_fields('dutchie_opts'); ?>
                <h2>API Settings</h2>
                <table class="form-table">
                    <tr><th>API URL</th><td><input type="text" name="<?php echo self::OPTION_NAME; ?>[api_url]" value="<?php echo esc_attr($url); ?>" class="regular-text" placeholder="https://your-api-domain.com"></td></tr>
                    <tr><th>API Key</th><td><input type="text" name="<?php echo self::OPTION_NAME; ?>[api_key]" value="<?php echo esc_attr($key); ?>" class="regular-text"></td></tr>
                </table>
                <hr><h2>Status</h2>
                <?php if ($cached && is_array($cached)): ?>
                    <p style="color:green;font-weight:bold;">&#10003; <?php echo count($cached); ?> banners cached</p>
                    <?php if ($age_minutes !== null): ?><p>Last refresh: <?php echo $age_minutes; ?> min ago</p><?php endif; ?>
                <?php elseif ($error): ?>
                    <p style="color:red;">&#10007; <?php echo esc_html($error); ?></p>
                <?php else: ?>
                    <p style="color:orange;">No cache. Click Refresh.</p>
                <?php endif; ?>
                <p><button type="button" class="button button-primary" onclick="dutchieRefresh()">Refresh Now</button> <button type="button" class="button" onclick="dutchieTest()">Test</button></p>
                <div id="result"></div>
                <hr><h2>Custom CSS</h2>
                <p>Add custom CSS to style the carousel or your custom template.</p>
                <textarea name="<?php echo self::OPTION_NAME; ?>[custom_css]" rows="8" style="width:100%;max-width:800px;font-family:monospace;"><?php echo esc_textarea($custom_css); ?></textarea>
                <hr><h2>Custom Template</h2>
                <p>Create your own HTML using <code>[dutchie_custom]</code>. Placeholders: <code>{{#banners}}...{{/banners}}</code>, <code>{{src}}</code>, <code>{{alt}}</code>, <code>{{link}}</code>, <code>{{index}}</code>, <code>{{count}}</code></p>
                <textarea name="<?php echo self::OPTION_NAME; ?>[custom_template]" rows="10" style="width:100%;max-width:800px;font-family:monospace;"><?php echo esc_textarea($custom_template); ?></textarea>
                <?php submit_button('Save Settings'); ?>
            </form>
            <hr><h2>Shortcodes</h2>
            <table class="widefat" style="max-width:800px;">
                <tr><td><code>[dutchie_banners]</code></td><td>Default carousel</td></tr>
                <tr><td><code>[dutchie_banners output="json"]</code></td><td>JSON data as <code>window.dutchieBanners</code></td></tr>
                <tr><td><code>[dutchie_banners output="images"]</code></td><td>Simple image list</td></tr>
                <tr style="background:#e7f5e7;"><td><code>[dutchie_custom]</code></td><td>Your custom template from above</td></tr>
            </table>
            <hr><h2>Debug</h2>
            <pre style="background:#1e1e1e;color:#d4d4d4;padding:10px;font-size:11px;max-height:300px;overflow:auto;"><?php echo esc_html($this->get_debug_log()); ?></pre>
        </div>
        <script>
        function dutchieTest(){document.getElementById('result').innerHTML='Testing...';jQuery.post(ajaxurl,{action:'dutchie_test'},function(r){document.getElementById('result').innerHTML='<p style="color:'+(r.success?'green':'red')+'">'+r.data+'</p>';setTimeout(function(){location.reload();},2000);});}
        function dutchieRefresh(){document.getElementById('result').innerHTML='Refreshing...';jQuery.post(ajaxurl,{action:'dutchie_refresh'},function(r){document.getElementById('result').innerHTML='<p style="color:'+(r.success?'green':'red')+'">'+r.data+'</p>';if(r.success)setTimeout(function(){location.reload();},1500);});}
        </script>
        <?php
    }

    public function ajax_test() {
        if (!current_user_can('manage_options')) wp_send_json_error('Unauthorized');
        $result = $this->fetch_api();
        if (is_wp_error($result)) wp_send_json_error($result->get_error_message());
        wp_send_json_success('Found ' . count($result) . ' banners.');
    }

    public function ajax_refresh() {
        if (!current_user_can('manage_options')) wp_send_json_error('Unauthorized');
        delete_transient(self::CACHE_KEY);
        $result = $this->fetch_api();
        if (is_wp_error($result)) { update_option(self::ERROR_KEY, $result->get_error_message()); wp_send_json_error($result->get_error_message()); }
        set_transient(self::CACHE_KEY, $result, self::CACHE_TIME);
        update_option(self::REFRESH_TIME_KEY, time());
        wp_send_json_success('Cached ' . count($result) . ' banners!');
    }

    public function ajax_bg_refresh() {
        if (get_transient('dutchie_refresh_lock')) { wp_send_json_success('In progress'); return; }
        set_transient('dutchie_refresh_lock', true, 60);
        $result = $this->fetch_api();
        if (!is_wp_error($result)) {
            set_transient(self::CACHE_KEY, $result, self::CACHE_TIME);
            update_option(self::REFRESH_TIME_KEY, time());
            delete_option(self::ERROR_KEY);
        }
        delete_transient('dutchie_refresh_lock');
        wp_send_json_success('Done');
    }

    public function maybe_trigger_refresh() {
        if (is_admin()) return;
        $opts = get_option(self::OPTION_NAME, array());
        if (empty($opts['api_url']) || empty($opts['api_key'])) return;
        $cached = get_transient(self::CACHE_KEY);
        $age = time() - get_option(self::REFRESH_TIME_KEY, 0);
        if (!$cached || !is_array($cached) || $age > 2100) {
            echo '<script>(function(){if(window.dRT)return;window.dRT=1;var x=new XMLHttpRequest();x.open("POST","' . admin_url('admin-ajax.php') . '",true);x.setRequestHeader("Content-Type","application/x-www-form-urlencoded");x.send("action=dutchie_bg_refresh");})();</script>';
        }
    }

    private function fetch_api() {
        $log = array('=== Dutchie Banner API Debug ===', 'Time: ' . current_time('Y-m-d H:i:s'));
        $opts = get_option(self::OPTION_NAME, array());
        $url = isset($opts['api_url']) ? trim($opts['api_url']) : '';
        $key = isset($opts['api_key']) ? trim($opts['api_key']) : '';
        if (!$url || !$key) { $this->save_debug_log($log); return new WP_Error('cfg', 'API URL and Key required'); }
        $endpoint = rtrim($url, '/') . '/api/banners?key=' . urlencode($key);
        $log[] = 'Endpoint: ' . preg_replace('/key=[^&]+/', 'key=***', $endpoint);
        $resp = wp_remote_get($endpoint, array('timeout' => 15, 'sslverify' => true, 'redirection' => 0, 'headers' => array('Accept' => 'application/json', 'User-Agent' => 'DutchieBannerCarousel/5.2.0')));
        if (is_wp_error($resp)) { $log[] = 'Error: ' . $resp->get_error_message(); $this->save_debug_log($log); return $resp; }
        $code = wp_remote_retrieve_response_code($resp);
        $body = wp_remote_retrieve_body($resp);
        $log[] = 'HTTP ' . $code . ' - ' . strlen($body) . ' bytes';
        if ($code !== 200) { $log[] = substr($body, 0, 300); $this->save_debug_log($log); return new WP_Error('http', "HTTP $code"); }
        $data = json_decode($body, true);
        if (!$data || !isset($data['banners'])) { $this->save_debug_log($log); return new WP_Error('json', 'Invalid response'); }
        $log[] = 'SUCCESS: ' . count($data['banners']) . ' banners';
        $this->save_debug_log($log);
        return $data['banners'];
    }

    private function save_debug_log($log) { update_option(self::ERROR_KEY . '_debug', implode("\n", $log)); }
    private function get_debug_log() { return get_option(self::ERROR_KEY . '_debug', 'Click Test to generate log.'); }

    public function shortcode_banners($atts) {
        $atts = shortcode_atts(array('output' => 'carousel', 'var' => 'dutchieBanners', 'class' => ''), $atts);
        $banners = get_transient(self::CACHE_KEY);
        if (!$banners || !is_array($banners) || empty($banners)) {
            return $atts['output'] === 'json' ? '<script>window.' . esc_js($atts['var']) . '=[];</script>' : '<!-- No banners -->';
        }
        if ($atts['output'] === 'json') {
            $d = array();
            foreach ($banners as $b) { $d[] = array('src' => $b['src'] ?? '', 'alt' => $b['alt'] ?? '', 'link' => $b['link'] ?? ''); }
            return '<script>window.' . esc_js($atts['var']) . '=' . wp_json_encode($d) . ';</script>';
        }
        if ($atts['output'] === 'images') {
            $o = '<div class="dutchie-images ' . esc_attr($atts['class']) . '">';
            foreach ($banners as $b) {
                if (!empty($b['link'])) $o .= '<a href="' . esc_url($b['link']) . '" target="_blank">';
                $o .= '<img src="' . esc_url($b['src']) . '" alt="' . esc_attr($b['alt'] ?? '') . '">';
                if (!empty($b['link'])) $o .= '</a>';
            }
            return $o . '</div>';
        }
        $id = 'dc' . wp_rand(1000, 9999);
        $n = count($banners);
        $o = '<div class="dutchie-carousel" id="' . $id . '"><div class="dutchie-track">';
        foreach ($banners as $b) {
            $o .= '<div class="dutchie-slide">';
            if (!empty($b['link'])) $o .= '<a href="' . esc_url($b['link']) . '" target="_blank">';
            $o .= '<img src="' . esc_url($b['src']) . '" alt="' . esc_attr($b['alt'] ?? '') . '" loading="lazy">';
            if (!empty($b['link'])) $o .= '</a>';
            $o .= '</div>';
        }
        $o .= '</div><button class="dutchie-prev">&#10094;</button><button class="dutchie-next">&#10095;</button><div class="dutchie-dots">';
        for ($i = 0; $i < $n; $i++) $o .= '<span class="dutchie-dot' . ($i === 0 ? ' active' : '') . '" data-i="' . $i . '"></span>';
        $o .= '</div></div>';
        $o .= '<script>(function(){var c=document.getElementById("' . $id . '"),t=c.querySelector(".dutchie-track"),n=' . $n . ',i=0,auto,drag=0,startX=0,dx=0,w,dragged=0;function go(x){i=((x%n)+n)%n;t.classList.add("animating");t.style.transform="translateX(-"+(i*100)+"%)";c.querySelectorAll(".dutchie-dot").forEach(function(d,j){d.classList.toggle("active",j===i)});ra();}function ra(){clearInterval(auto);auto=setInterval(function(){go(i+1)},5000);}c.querySelector(".dutchie-prev").onclick=function(){go(i-1)};c.querySelector(".dutchie-next").onclick=function(){go(i+1)};c.querySelectorAll(".dutchie-dot").forEach(function(d){d.onclick=function(){go(+d.dataset.i)}});c.addEventListener("click",function(e){if(dragged){e.preventDefault();e.stopPropagation();dragged=0}},true);function dn(e){if(e.target.closest("button"))return;drag=1;dragged=0;startX=e.touches?e.touches[0].clientX:e.clientX;dx=0;w=c.offsetWidth;t.classList.remove("animating");c.classList.add("dragging");clearInterval(auto)}function mv(e){if(!drag)return;var x=e.touches?e.touches[0].clientX:e.clientX;dx=x-startX;if(Math.abs(dx)>5){e.preventDefault();dragged=1}t.style.transform="translateX(calc(-"+(i*100)+"% + "+dx+"px))"}function up(){if(!drag)return;drag=0;c.classList.remove("dragging");var th=w*0.15;if(dx<-th&&i<n-1)go(i+1);else if(dx>th&&i>0)go(i-1);else go(i)}t.onmousedown=dn;t.ontouchstart=dn;document.onmousemove=function(e){if(drag)mv(e)};t.ontouchmove=mv;document.onmouseup=up;t.ontouchend=up;t.ondragstart=function(){return false};ra()})();</script>';
        return $o;
    }

    public function shortcode_custom($atts) {
        $banners = get_transient(self::CACHE_KEY);
        if (!$banners || empty($banners)) return '<!-- No banners -->';
        $opts = get_option(self::OPTION_NAME, array());
        $tpl = isset($opts['custom_template']) ? $opts['custom_template'] : '';
        if (empty(trim($tpl))) {
            $tpl = '<div class="dutchie-custom">{{#banners}}<div><a href="{{link}}" target="_blank"><img src="{{src}}" alt="{{alt}}"></a></div>{{/banners}}</div>';
        }
        $out = str_replace('{{count}}', count($banners), $tpl);
        if (preg_match('/\{\{#banners\}\}(.*?)\{\{\/banners\}\}/s', $out, $m)) {
            $loop = '';
            foreach ($banners as $idx => $b) {
                $item = $m[1];
                $item = str_replace('{{src}}', esc_url($b['src'] ?? ''), $item);
                $item = str_replace('{{alt}}', esc_attr($b['alt'] ?? ''), $item);
                $item = str_replace('{{link}}', esc_url($b['link'] ?? ''), $item);
                $item = str_replace('{{index}}', $idx, $item);
                $loop .= $item;
            }
            $out = preg_replace('/\{\{#banners\}\}(.*?)\{\{\/banners\}\}/s', $loop, $out);
        }
        return $out;
    }

    public function output_styles() {
        echo '<style>
.dutchie-carousel{position:relative;overflow:hidden;max-width:100%;cursor:grab;touch-action:pan-y pinch-zoom;-webkit-user-select:none;user-select:none}
.dutchie-carousel.dragging{cursor:grabbing}
.dutchie-track{display:flex;will-change:transform}
.dutchie-track.animating{transition:transform .3s ease-out}
.dutchie-slide{min-width:100%;flex-shrink:0}
.dutchie-slide img{width:100%;height:auto;display:block;pointer-events:none;-webkit-user-drag:none}
.dutchie-slide a{display:block;width:100%}
.dutchie-prev,.dutchie-next{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);color:#fff;border:none;padding:15px 10px;cursor:pointer;font-size:18px;z-index:10;transition:background .2s}
.dutchie-prev{left:0;border-radius:0 4px 4px 0}
.dutchie-next{right:0;border-radius:4px 0 0 4px}
.dutchie-prev:hover,.dutchie-next:hover{background:rgba(0,0,0,.8)}
.dutchie-dots{position:absolute;bottom:10px;left:0;right:0;text-align:center;pointer-events:none}
.dutchie-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.5);margin:0 4px;cursor:pointer;pointer-events:auto;transition:all .2s}
.dutchie-dot.active{background:#fff;transform:scale(1.2)}
@media(max-width:768px){.dutchie-prev,.dutchie-next{padding:18px 12px;font-size:22px}.dutchie-dot{width:10px;height:10px;margin:0 5px}}
</style>';
        $opts = get_option(self::OPTION_NAME, array());
        if (!empty($opts['custom_css'])) echo '<style id="dutchie-custom-css">' . $opts['custom_css'] . '</style>';
    }
}

new DutchieBannerCarousel();
