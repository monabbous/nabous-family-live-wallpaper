const WeatherService = (() => {
    const CONFIG = {
        refreshIntervalMs: 15 * 60 * 1000,
        weatherCacheDurationMs: 0.001 * 60 * 1000,

        gpsCacheDurationMs: 0.001 * 60 * 60 * 1000,
        ipCacheDurationMs: 0.001 * 6 * 60 * 60 * 1000,

        requestTimeoutMs: 10_000,

        // If WebWallpaper rejects GPS, don't retry it
        // on every 15-minute weather refresh.
        gpsRetryDelayMs: 0.001 * 6 * 60 * 60 * 1000,

        fallbackLocation: {
            latitude: 32.12,
            longitude: 20.07,
        },

        weatherCacheKey: "live-wallpaper-weather-v4",
        locationCacheKey: "live-wallpaper-location-v4",
    };

    let refreshTimer = null;
    let gpsUnavailableUntil = 0;

    const WEATHER_CODES = {
        0: { label: "Clear", icon: "☀️" },
        1: { label: "Mostly clear", icon: "🌤️" },
        2: { label: "Partly cloudy", icon: "⛅" },
        3: { label: "Overcast", icon: "☁️" },

        45: { label: "Fog", icon: "🌫️" },
        48: { label: "Rime fog", icon: "🌫️" },

        51: { label: "Light drizzle", icon: "🌦️" },
        53: { label: "Drizzle", icon: "🌦️" },
        55: { label: "Heavy drizzle", icon: "🌧️" },

        61: { label: "Light rain", icon: "🌧️" },
        63: { label: "Rain", icon: "🌧️" },
        65: { label: "Heavy rain", icon: "🌧️" },

        71: { label: "Light snow", icon: "🌨️" },
        73: { label: "Snow", icon: "🌨️" },
        75: { label: "Heavy snow", icon: "❄️" },

        80: { label: "Rain showers", icon: "🌦️" },
        81: { label: "Rain showers", icon: "🌧️" },
        82: { label: "Heavy showers", icon: "⛈️" },

        95: { label: "Thunderstorm", icon: "⛈️" },
        96: { label: "Thunderstorm", icon: "⛈️" },
        99: { label: "Severe thunderstorm", icon: "⛈️" },
    };

    function getWeatherMeta(code, isDay = true) {
        if (!isDay && (code === 0 || code === 1)) {
            return {
                label: code === 0 ? "Clear" : "Mostly clear",
                icon: "🌙",
            };
        }

        return (
            WEATHER_CODES[code] ?? {
                label: "Unknown",
                icon: "🌡️",
            }
        );
    }

    // ---------------------------------------------------------
    // Storage
    // ---------------------------------------------------------

    function readJSON(key) {
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch {
            return null;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(
                key,
                JSON.stringify(value)
            );
        } catch {
            // Some wallpaper runtimes may restrict localStorage.
        }
    }

    // ---------------------------------------------------------
    // Fetch helper
    // ---------------------------------------------------------

    async function fetchWithTimeout(url) {
        const controller = new AbortController();

        const timeout = setTimeout(
            () => controller.abort(),
            CONFIG.requestTimeoutMs
        );

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                cache: "no-store",
            });

            if (!response.ok) {
                throw new Error(
                    `Request failed: ${response.status}`
                );
            }

            return await response.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    // ---------------------------------------------------------
    // Location helpers
    // ---------------------------------------------------------

    function isValidLocation(location) {
        return (
            Number.isFinite(location?.latitude) &&
            Number.isFinite(location?.longitude)
        );
    }

    function getLocationCacheMaxAge(location) {
        switch (location?.source) {
            case "gps":
                return CONFIG.gpsCacheDurationMs;

            case "ip":
                return CONFIG.ipCacheDurationMs;

            default:
                return 0;
        }
    }

    function getCachedLocation() {
        const stored =
            readJSON(CONFIG.locationCacheKey);

        if (
            !isValidLocation(stored) ||
            !stored?.timestamp
        ) {
            return null;
        }

        const maxAge =
            getLocationCacheMaxAge(stored);

        if (
            maxAge <= 0 ||
            Date.now() - stored.timestamp > maxAge
        ) {
            return null;
        }

        return stored;
    }

    function cacheLocation(location) {
        const cached = {
            ...location,
            timestamp: Date.now(),
        };

        writeJSON(
            CONFIG.locationCacheKey,
            cached
        );

        return cached;
    }

    // ---------------------------------------------------------
    // GPS
    // ---------------------------------------------------------

    function getBrowserLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(
                    new Error(
                        "Browser geolocation unavailable"
                    )
                );

                return;
            }

            navigator.geolocation.getCurrentPosition(
                ({ coords }) => {
                    resolve({
                        latitude:
                            coords.latitude,

                        longitude:
                            coords.longitude,

                        accuracy:
                            coords.accuracy,

                        source: "gps",
                    });
                },

                reject,

                {
                    enableHighAccuracy: false,

                    timeout: 8_000,

                    maximumAge:
                        60 * 60 * 1000,
                }
            );
        });
    }

    // ---------------------------------------------------------
    // Reverse geocode GPS coordinates
    // ---------------------------------------------------------

    async function reverseGeocodeCoordinates(
        latitude,
        longitude
    ) {
        const url = new URL(
            "https://api.bigdatacloud.net/data/reverse-geocode-client"
        );

        url.search = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            localityLanguage: "en",
        });

        const data =
            await fetchWithTimeout(url);

        return {
            city:
                data.city ||
                data.locality ||
                null,

            region:
                data.principalSubdivision ||
                null,

            country:
                data.countryName ||
                null,

            countryCode:
                data.countryCode ||
                null,
        };
    }

    async function getLocationFromMac() {
        const response = await fetch(
            "/api/location",
            {
                cache: "no-store",
            }
        );

        if (!response.ok) {
            throw new Error(
                `Mac location API failed: ${response.status}`
            );
        }

        const data = await response.json();

        if (
            !data.ok ||
            !Number.isFinite(data.latitude) ||
            !Number.isFinite(data.longitude)
        ) {
            throw new Error(
                data.error ||
                "Invalid location response"
            );
        }

        return {
            latitude: data.latitude,
            longitude: data.longitude,

            city: data.city || null,
            region: data.region || null,
            country: data.country || null,
            countryCode:
                data.country_code || null,

            accuracy:
                data.accuracy_m || null,

            source: "macos",
        };
    }

    async function getLocationFromGPS() {
        const gps =
            await getBrowserLocation();

        try {
            const place =
                await reverseGeocodeCoordinates(
                    gps.latitude,
                    gps.longitude
                );

            return {
                ...gps,
                ...place,
            };
        } catch (error) {
            /*
             * GPS itself still worked.
             *
             * We can use the precise coordinates for
             * weather even if reverse geocoding fails.
             */
            console.warn(
                "GPS reverse geocoding failed:",
                error
            );

            return gps;
        }
    }

    // ---------------------------------------------------------
    // IP location fallback
    // ---------------------------------------------------------

    async function getLocationFromIP() {
        const response = await fetch(
            "https://ipwho.is/",
            {
                cache: "no-store",
            }
        );

        if (!response.ok) {
            throw new Error(
                `IP geolocation failed: ${response.status}`
            );
        }

        const data =
            await response.json();

        if (
            !data.success ||
            !Number.isFinite(data.latitude) ||
            !Number.isFinite(data.longitude)
        ) {
            throw new Error(
                "Invalid IP geolocation response"
            );
        }

        return {
            latitude:
                data.latitude,

            longitude:
                data.longitude,

            city:
                data.city || null,

            region:
                data.region || null,

            country:
                data.country || null,

            countryCode:
                data.country_code || null,

            timezone:
                data.timezone?.id || null,

            source: "ip",
        };
    }

    // ---------------------------------------------------------
    // GPS → IP → manual fallback
    // ---------------------------------------------------------

    async function resolveLocation() {
        const cached =
            getCachedLocation();

        /*
         * If we already have a recent GPS fix,
         * that's the highest-quality result.
         */
        if (cached?.source === "gps") {
            return cached;
        }

        /*
         * GPS FIRST
         */
        if (
            Date.now() >= gpsUnavailableUntil
        ) {
            try {
                const gpsLocation =
                    await getLocationFromGPS();

                return cacheLocation(
                    gpsLocation
                );
            } catch (error) {


                gpsUnavailableUntil =
                    Date.now() +
                    CONFIG.gpsRetryDelayMs;

                console.warn(
                    "GPS unavailable; falling back to IP:",
                    error
                );
            }
        }


        try {
            const macLocation =
                await getLocationFromMac();

            return cacheLocation(
                macLocation
            );
        } catch (error) {
            console.warn(
                "MacOS location service unavailable:",
                error
            );
        }

        /*
         * IP SECOND
         *
         * Reuse a recent cached IP result before
         * contacting the IP service again.
         */
        if (cached?.source === "ip") {
            return cached;
        }

        try {
            const ipLocation =
                await getLocationFromIP();

            return cacheLocation(
                ipLocation
            );
        } catch (error) {
            console.warn(
                "IP location unavailable:",
                error
            );
        }

        /*
         * MANUAL FALLBACK LAST
         */
        const {
            latitude,
            longitude,
        } = CONFIG.fallbackLocation;

        if (
            Number.isFinite(latitude) &&
            Number.isFinite(longitude)
        ) {
            return {
                latitude,
                longitude,

                city: null,
                region: null,
                country: null,
                countryCode: null,

                source: "fallback",
            };
        }

        throw new Error(
            "Unable to determine weather location"
        );
    }

    // ---------------------------------------------------------
    // Weather API
    // ---------------------------------------------------------

    function createWeatherURL(
        latitude,
        longitude
    ) {
        const url = new URL(
            "https://api.open-meteo.com/v1/forecast"
        );

        url.search = new URLSearchParams({
            latitude:
                String(latitude),

            longitude:
                String(longitude),

            current: [
                "temperature_2m",
                "apparent_temperature",
                "relative_humidity_2m",
                "weather_code",
                "wind_speed_10m",
                "wind_direction_10m",
                "is_day",
            ].join(","),

            daily: [
                "temperature_2m_max",
                "temperature_2m_min",
                "sunrise",
                "sunset",
                "precipitation_probability_max",
            ].join(","),

            timezone: "auto",

            forecast_days: "2",
        });

        return url;
    }

    // ---------------------------------------------------------
    // Normalize weather result
    // ---------------------------------------------------------

    function normalizeWeather(
        data,
        location
    ) {
        const current =
            data.current;

        const daily =
            data.daily;

        if (!current || !daily) {
            throw new Error(
                "Invalid weather response"
            );
        }

        const meta =
            getWeatherMeta(
                current.weather_code,
                current.is_day === 1
            );

        return {
            fetchedAt:
                Date.now(),

            timezone:
                data.timezone,

            location: {
                city:
                    location.city ?? null,

                region:
                    location.region ?? null,

                country:
                    location.country ?? null,

                countryCode:
                    location.countryCode ?? null,

                latitude:
                    location.latitude,

                longitude:
                    location.longitude,

                accuracy:
                    location.accuracy ?? null,

                source:
                    location.source ?? null,
            },

            current: {
                temperature:
                    current.temperature_2m,

                apparentTemperature:
                    current.apparent_temperature,

                humidity:
                    current.relative_humidity_2m,

                windSpeed:
                    current.wind_speed_10m,

                windDirection:
                    current.wind_direction_10m,

                weatherCode:
                    current.weather_code,

                isDay:
                    current.is_day === 1,

                condition:
                    meta.label,

                icon:
                    meta.icon,
            },

            today: {
                high:
                    daily.temperature_2m_max?.[0],

                low:
                    daily.temperature_2m_min?.[0],

                precipitationProbability:
                    daily.precipitation_probability_max?.[0],

                sunrise:
                    daily.sunrise?.[0],

                sunset:
                    daily.sunset?.[0],
            },
        };
    }

    // ---------------------------------------------------------
    // Weather cache
    // ---------------------------------------------------------

    function getCachedWeather() {
        const cached =
            readJSON(
                CONFIG.weatherCacheKey
            );

        if (
            !cached?.data ||
            !cached.timestamp
        ) {
            return null;
        }

        if (
            Date.now() -
            cached.timestamp >
            CONFIG.weatherCacheDurationMs
        ) {
            return null;
        }

        return cached.data;
    }

    function cacheWeather(data) {
        writeJSON(
            CONFIG.weatherCacheKey,
            {
                timestamp: Date.now(),
                data,
            }
        );
    }

    // ---------------------------------------------------------
    // Fetch weather
    // ---------------------------------------------------------

    async function fetchWeather({
        force = false,
    } = {}) {
        if (!force) {
            const cached =
                getCachedWeather();

            if (cached) {
                return cached;
            }
        }

        const location =
            await resolveLocation();

        const url =
            createWeatherURL(
                location.latitude,
                location.longitude
            );

        const raw =
            await fetchWithTimeout(url);

        const weather =
            normalizeWeather(
                raw,
                location
            );

        cacheWeather(weather);

        return weather;
    }

    // ---------------------------------------------------------
    // Auto refresh
    // ---------------------------------------------------------

    function startAutoRefresh(
        callback
    ) {
        stopAutoRefresh();

        refreshTimer =
            setInterval(
                async () => {
                    try {
                        const weather =
                            await fetchWeather({
                                force: true,
                            });

                        callback(weather);
                    } catch (error) {
                        console.error(
                            "Weather refresh failed:",
                            error
                        );
                    }
                },

                CONFIG.refreshIntervalMs
            );
    }

    function stopAutoRefresh() {
        if (!refreshTimer) {
            return;
        }

        clearInterval(
            refreshTimer
        );

        refreshTimer = null;
    }

    function clearLocation() {
        try {
            localStorage.removeItem(
                CONFIG.locationCacheKey
            );
        } catch { }

        gpsUnavailableUntil = 0;
    }

    return {
        fetchWeather,
        startAutoRefresh,
        stopAutoRefresh,
        clearLocation,
    };
})();


// =========================================================
// UI helpers
// =========================================================

function formatTime(isoString) {
    if (!isoString) {
        return "";
    }

    const date =
        new Date(isoString);

    return date.toLocaleTimeString(
        [],
        {
            hour: "2-digit",
            minute: "2-digit",
        }
    );
}


function formatLocation(location) {
    if (!location) {
        return "";
    }

    const parts = [
        // location.city,
        location.region,
        location.country,
    ].filter(Boolean);

    const uniqueParts =
        [...new Set(parts)];

    if (uniqueParts.length) {
        return uniqueParts.join(", ");
    }

    /*
     * GPS may succeed while reverse geocoding
     * fails. Show coordinates instead.
     */
    if (
        Number.isFinite(
            location.latitude
        ) &&
        Number.isFinite(
            location.longitude
        )
    ) {
        return (
            `${location.latitude.toFixed(2)}, ` +
            `${location.longitude.toFixed(2)}`
        );
    }

    return "";
}


function renderWeather(weather) {
    const icon =
        document.getElementById(
            "weather-icon"
        );

    const temp =
        document.getElementById(
            "weather-temp"
        );

    const condition =
        document.getElementById(
            "weather-condition"
        );

    const sun =
        document.getElementById(
            "weather-sunset"
        );

    const location =
        document.getElementById(
            "weather-location"
        );

    if (icon) {
        icon.textContent =
            weather.current.icon;
    }

    if (temp) {
        temp.innerHTML =
            stringToMonospaceSpans(`${Math.round(
                weather.current.temperature
            )}°`);
    }

    if (condition) {
        condition.innerHTML =
            stringToMonospaceSpans(weather.current.condition);
    }

    if (sun) {
        sun.innerHTML =
            stringToMonospaceSpans(
                weather.current.isDay
                    ? `Sunset ${formatTime(
                        weather.today.sunset
                    )}`
                    : `Sunrise ${formatTime(
                        weather.today.sunrise
                    )}`);
    }

    if (location) {
        location.innerHTML =
            stringToMonospaceSpans(
                formatLocation(
                    weather.location
                )
            );
    }

    /*
     * Optional debugging:
     *
     * console.log(
     *   "Location source:",
     *   weather.location.source
     * );
     */
}


// =========================================================
// Initialize
// =========================================================

async function initWeather() {
    try {
        const weather =
            await WeatherService.fetchWeather();

        renderWeather(weather);

        WeatherService.startAutoRefresh(
            renderWeather
        );
    } catch (error) {
        console.error(
            "Unable to initialize weather:",
            error
        );

        const condition =
            document.getElementById(
                "weather-condition"
            );

        if (condition) {
            condition.innerHTML =
                stringToMonospaceSpans("Weather unavailable");
        }
    }
}

initWeather();


