import Foundation
import CoreLocation
import Darwin

// MARK: - Logging

private func log(_ message: String) {
    let timestamp =
        ISO8601DateFormatter()
            .string(
                from: Date()
            )

    let line =
        "[\(timestamp)] \(message)\n"

    guard
        let data =
            line.data(
                using: .utf8
            )
    else {
        return
    }

    FileHandle
        .standardError
        .write(data)
}


// MARK: - Configuration

struct Configuration {
    let root: URL
    let port: UInt16

    static func fromArguments()
        -> Configuration
    {
        var root =
            URL(
                fileURLWithPath:
                    FileManager
                        .default
                        .currentDirectoryPath,

                isDirectory:
                    true
            )

        var port:
            UInt16 = 8765

        let arguments =
            CommandLine.arguments

        var index = 1

        while
            index <
                arguments.count
        {
            switch
                arguments[index]
            {
            case "--root":

                if
                    index + 1 <
                        arguments.count
                {
                    root =
                        URL(
                            fileURLWithPath:
                                arguments[
                                    index + 1
                                ],

                            isDirectory:
                                true
                        )

                    index += 1
                }


            case "--port":

                if
                    index + 1 <
                        arguments.count,

                    let value =
                        UInt16(
                            arguments[
                                index + 1
                            ]
                        )
                {
                    port = value
                    index += 1
                }


            default:
                break
            }

            index += 1
        }

        return Configuration(
            root:
                root
                    .standardizedFileURL
                    .resolvingSymlinksInPath(),

            port:
                port
        )
    }
}


// MARK: - Resource Paths

private func findGeodataDirectory()
    -> URL
{
    /*
     Preferred path:

       Wallserve.app/
       └── Contents/
           ├── MacOS/
           │   └── Wallserve
           └── Resources/
               └── geodata/

     Bundle.main.resourceURL should work for
     the normal .app installation.
     */

    if
        let resources =
            Bundle.main.resourceURL
    {
        return resources
            .appendingPathComponent(
                "geodata",
                isDirectory: true
            )
    }

    /*
     Fallback based on executable path.

     Contents/MacOS/Wallserve
          ↑
       MacOS
          ↑
       Contents
    */

    let executable =
        URL(
            fileURLWithPath:
                CommandLine.arguments[0]
        )
        .standardizedFileURL
        .resolvingSymlinksInPath()

    let contents =
        executable
            .deletingLastPathComponent()
            .deletingLastPathComponent()

    return contents
        .appendingPathComponent(
            "Resources/geodata",
            isDirectory: true
        )
}


// MARK: - Location Models

private struct LocationFix:
    Codable
{
    let latitude: Double
    let longitude: Double

    let horizontalAccuracy:
        Double

    let altitude:
        Double

    let timestamp:
        Date

    let source:
        String

    init(
        location:
            CLLocation,

        source:
            String
    ) {
        latitude =
            location
                .coordinate
                .latitude

        longitude =
            location
                .coordinate
                .longitude

        horizontalAccuracy =
            location
                .horizontalAccuracy

        altitude =
            location
                .altitude

        timestamp =
            location
                .timestamp

        self.source =
            source
    }


    init(
        latitude: Double,
        longitude: Double,

        horizontalAccuracy:
            Double,

        altitude:
            Double,

        timestamp:
            Date,

        source:
            String
    ) {
        self.latitude =
            latitude

        self.longitude =
            longitude

        self.horizontalAccuracy =
            horizontalAccuracy

        self.altitude =
            altitude

        self.timestamp =
            timestamp

        self.source =
            source
    }


    var age:
        TimeInterval
    {
        max(
            0,

            Date()
                .timeIntervalSince(
                    timestamp
                )
        )
    }
}


private struct PersistedState:
    Codable
{
    var lastCoreLocation:
        LocationFix?

    var lastIPLocation:
        LocationFix?
}


private struct RuntimeState {
    var currentFix:
        LocationFix?

    var currentPlace:
        OfflinePlace?

    var lastCoreLocation:
        LocationFix?

    var lastIPLocation:
        LocationFix?

    var authorizationStatus:
        CLAuthorizationStatus =
            .notDetermined

    var receivedFreshCoreLocation =
        false

    var locationError:
        String?

    var isResolvingIP =
        false

    var ipError:
        String?
}


// MARK: - IP Response

private struct IPLocationResponse:
    Decodable
{
    let success:
        Bool?

    let latitude:
        Double?

    let longitude:
        Double?
}


// MARK: - Location Provider

final class LocationProvider:
    NSObject,
    CLLocationManagerDelegate
{
    private let manager =
        CLLocationManager()

    private let geocoder:
        GeoNamesGeocoder?

    private let stateLock =
        NSLock()

    private var state =
        RuntimeState()

    /*
     Give Core Location a short time to provide
     a fix before starting the IP fallback.
     */
    private let ipFallbackDelay:
        TimeInterval = 3


    /*
     If the persisted Core Location fix is
     extremely old, prefer IP until macOS
     acquires another real position.

     One day is conservative for a desktop Mac.
     */
    private let maximumCachedCoreAge:
        TimeInterval =
            24 * 60 * 60


    // MARK: Cache

    private lazy var cacheURL:
        URL =
    {
        let fileManager =
            FileManager.default

        let applicationSupport =
            fileManager.urls(
                for:
                    .applicationSupportDirectory,

                in:
                    .userDomainMask
            )
            .first!

        let directory =
            applicationSupport
                .appendingPathComponent(
                    "Wallserve",
                    isDirectory:
                        true
                )

        do {
            try fileManager
                .createDirectory(
                    at:
                        directory,

                    withIntermediateDirectories:
                        true
                )

        } catch {
            log(
                "Unable to create Wallserve cache directory: \(error.localizedDescription)"
            )
        }

        return directory
            .appendingPathComponent(
                "location-cache.json"
            )
    }()


    // MARK: Init

    init(
        geocoder:
            GeoNamesGeocoder?
    ) {
        self.geocoder =
            geocoder

        super.init()

        loadPersistedState()

        manager.delegate =
            self

        manager.desiredAccuracy =
            kCLLocationAccuracyHundredMeters

        manager.distanceFilter =
            500

        let authorization =
            manager
                .authorizationStatus

        withState {
            $0.authorizationStatus =
                authorization
        }

        /*
         Resolve a human-readable name for the
         persisted coordinate immediately.
         */
        refreshOfflinePlace()

        guard
            CLLocationManager
                .locationServicesEnabled()
        else {
            withState {
                $0.locationError =
                    "Location Services disabled"
            }

            log(
                "Core Location services disabled"
            )

            resolveIPFallbackIfNeeded()

            return
        }

        handleAuthorization(
            authorization
        )
    }


    // MARK: State

    @discardableResult
    private func withState<T>(
        _ block:
            (inout RuntimeState) -> T
    ) -> T
    {
        stateLock.lock()

        defer {
            stateLock.unlock()
        }

        return block(
            &state
        )
    }


    // MARK: Persistence

    private func loadPersistedState() {
        do {
            let data =
                try Data(
                    contentsOf:
                        cacheURL
                )

            let decoder =
                JSONDecoder()

            decoder.dateDecodingStrategy =
                .iso8601

            let persisted =
                try decoder
                    .decode(
                        PersistedState.self,
                        from:
                            data
                    )

            withState {
                state in

                state.lastCoreLocation =
                    persisted
                        .lastCoreLocation

                state.lastIPLocation =
                    persisted
                        .lastIPLocation

                /*
                 Core Location coordinates take
                 priority over IP.
                 */
                if
                    let core =
                        persisted
                            .lastCoreLocation,

                    core.age <=
                        maximumCachedCoreAge
                {
                    state.currentFix =
                        LocationFix(
                            latitude:
                                core.latitude,

                            longitude:
                                core.longitude,

                            horizontalAccuracy:
                                core.horizontalAccuracy,

                            altitude:
                                core.altitude,

                            timestamp:
                                core.timestamp,

                            source:
                                "cache-corelocation"
                        )

                } else if
                    let ip =
                        persisted
                            .lastIPLocation
                {
                    state.currentFix =
                        LocationFix(
                            latitude:
                                ip.latitude,

                            longitude:
                                ip.longitude,

                            horizontalAccuracy:
                                ip.horizontalAccuracy,

                            altitude:
                                ip.altitude,

                            timestamp:
                                ip.timestamp,

                            source:
                                "cache-ip"
                        )
                }
            }

            log(
                "Loaded persisted location state"
            )

        } catch {
            log(
                "No persisted location state"
            )
        }
    }


    private func persistState() {
        let snapshot =
            withState {
                state in

                PersistedState(
                    lastCoreLocation:
                        state
                            .lastCoreLocation,

                    lastIPLocation:
                        state
                            .lastIPLocation
                )
            }

        do {
            let encoder =
                JSONEncoder()

            encoder.outputFormatting = [
                .prettyPrinted,
                .sortedKeys
            ]

            encoder.dateEncodingStrategy =
                .iso8601

            let data =
                try encoder
                    .encode(
                        snapshot
                    )

            try data.write(
                to:
                    cacheURL,

                options:
                    .atomic
            )

        } catch {
            log(
                "Unable to persist location: \(error.localizedDescription)"
            )
        }
    }


    // MARK: Authorization

    func locationManagerDidChangeAuthorization(
        _ manager:
            CLLocationManager
    ) {
        let status =
            manager
                .authorizationStatus

        withState {
            $0.authorizationStatus =
                status
        }

        handleAuthorization(
            status
        )
    }


    private func handleAuthorization(
        _ status:
            CLAuthorizationStatus
    ) {
        switch status {

        case .authorizedAlways,
             .authorizedWhenInUse:

            log(
                "Core Location authorized: \(authorizationString(status))"
            )

            /*
             macOS may already have a location
             cached internally.
             */
            if
                let systemLocation =
                    manager.location
            {
                acceptCoreLocation(
                    systemLocation,

                    source:
                        "corelocation-system-cache"
                )
            }

            manager
                .startUpdatingLocation()

            DispatchQueue
                .main
                .asyncAfter(
                    deadline:
                        .now()
                        +
                        ipFallbackDelay
                )
            {
                [weak self] in

                self?
                    .resolveIPFallbackIfNeeded()
            }


        case .notDetermined:

            log(
                "Requesting location authorization"
            )

            manager
                .requestWhenInUseAuthorization()


        case .denied:

            withState {
                $0.locationError =
                    "Location permission denied"
            }

            log(
                "Core Location denied"
            )

            resolveIPFallbackIfNeeded()


        case .restricted:

            withState {
                $0.locationError =
                    "Location Services restricted"
            }

            log(
                "Core Location restricted"
            )

            resolveIPFallbackIfNeeded()


        @unknown default:

            withState {
                $0.locationError =
                    "Unknown authorization state"
            }

            resolveIPFallbackIfNeeded()
        }
    }


    // MARK: Core Location Delegate

    func locationManager(
        _ manager:
            CLLocationManager,

        didUpdateLocations locations:
            [CLLocation]
    ) {
        guard
            let location =
                locations.last
        else {
            return
        }

        guard
            location.horizontalAccuracy
            >= 0
        else {
            return
        }

        acceptCoreLocation(
            location,

            source:
                "corelocation"
        )
    }


    func locationManager(
        _ manager:
            CLLocationManager,

        didFailWithError error:
            Error
    ) {
        let nsError =
            error as NSError

        /*
         kCLErrorDomain 0 =
         locationUnknown.

         This is transient.

         Never erase an existing fix.
         */
        if
            nsError.domain ==
                kCLErrorDomain,

            nsError.code ==
                CLError.Code
                    .locationUnknown
                    .rawValue
        {
            log(
                "Core Location temporarily unavailable"
            )

            let hasFix =
                withState {
                    $0.currentFix != nil
                }

            if !hasFix {
                withState {
                    $0.locationError =
                        "Location temporarily unavailable"
                }

                resolveIPFallbackIfNeeded()
            }

            return
        }

        let hasFix =
            withState {
                state -> Bool in

                if
                    state.currentFix ==
                        nil
                {
                    state.locationError =
                        error
                            .localizedDescription
                }

                return state.currentFix != nil
            }

        log(
            "Core Location error: \(error.localizedDescription)"
        )

        if !hasFix {
            resolveIPFallbackIfNeeded()
        }
    }


    // MARK: Core Location

    private func acceptCoreLocation(
        _ location:
            CLLocation,

        source:
            String
    ) {
        let fix =
            LocationFix(
                location:
                    location,

                source:
                    source
            )

        log(
            String(
                format:
                    "Core Location %.6f, %.6f accuracy %.0fm age %.0fs",
                fix.latitude,
                fix.longitude,
                fix.horizontalAccuracy,
                fix.age
            )
        )

        withState {
            state in

            state.currentFix =
                fix

            state.lastCoreLocation =
                fix

            state.receivedFreshCoreLocation =
                true

            state.locationError =
                nil
        }

        refreshOfflinePlace()

        persistState()
    }


    // MARK: Offline GeoNames

    private func refreshOfflinePlace() {
        guard
            let geocoder
        else {
            return
        }

        let fix =
            withState {
                $0.currentFix
            }

        guard let fix else {
            return
        }

        let place =
            geocoder
                .reverseGeocode(
                    latitude:
                        fix.latitude,

                    longitude:
                        fix.longitude
                )

        withState {
            $0.currentPlace =
                place
        }

        if let place {
            log(
                String(
                    format:
                        "GeoNames resolved: %@ (%.1f km from nearest populated place)",
                    place.displayName,
                    place.distanceKilometers
                )
            )
        } else {
            log(
                "GeoNames could not resolve current coordinates"
            )
        }
    }


    // MARK: IP Coordinate Fallback

    private func resolveIPFallbackIfNeeded() {
        let shouldResolve =
            withState {
                state -> Bool in

                if state.isResolvingIP {
                    return false
                }

                /*
                 Any valid Core Location coordinate
                 beats IP coordinates.
                 */
                if
                    let fix =
                        state.currentFix,

                    isCoreLocationSource(
                        fix.source
                    )
                {
                    return false
                }

                state.isResolvingIP =
                    true

                state.ipError =
                    nil

                return true
            }

        guard shouldResolve else {
            return
        }

        guard
            let url =
                URL(
                    string:
                        "https://ipwho.is/"
                )
        else {
            finishIPFailure(
                "Invalid IP geolocation URL"
            )

            return
        }

        var request =
            URLRequest(
                url:
                    url
            )

        request.timeoutInterval =
            10

        request.cachePolicy =
            .reloadIgnoringLocalCacheData

        log(
            "Requesting IP coordinate fallback"
        )

        URLSession.shared
            .dataTask(
                with:
                    request
            )
        {
            [weak self]
            data,
            response,
            error in

            guard let self else {
                return
            }

            if let error {
                self
                    .finishIPFailure(
                        error
                            .localizedDescription
                    )

                return
            }

            guard
                let response =
                    response
                    as?
                    HTTPURLResponse,

                (200..<300)
                    .contains(
                        response
                            .statusCode
                    )
            else {
                self
                    .finishIPFailure(
                        "IP geolocation HTTP request failed"
                    )

                return
            }

            guard let data else {
                self
                    .finishIPFailure(
                        "IP geolocation returned no data"
                    )

                return
            }

            do {
                let result =
                    try JSONDecoder()
                        .decode(
                            IPLocationResponse.self,

                            from:
                                data
                        )

                guard
                    result.success
                        != false,

                    let latitude =
                        result.latitude,

                    let longitude =
                        result.longitude
                else {
                    throw ServerError(
                        "IP geolocation returned invalid coordinates"
                    )
                }

                self
                    .acceptIPLocation(
                        latitude:
                            latitude,

                        longitude:
                            longitude
                    )

            } catch {
                self
                    .finishIPFailure(
                        error
                            .localizedDescription
                    )
            }
        }
        .resume()
    }


    private func acceptIPLocation(
        latitude:
            Double,

        longitude:
            Double
    ) {
        let ipFix =
            LocationFix(
                latitude:
                    latitude,

                longitude:
                    longitude,

                horizontalAccuracy:
                    -1,

                altitude:
                    0,

                timestamp:
                    Date(),

                source:
                    "ip"
            )

        let accepted =
            withState {
                state -> Bool in

                state.isResolvingIP =
                    false

                state.ipError =
                    nil

                state.lastIPLocation =
                    ipFix

                /*
                 Core Location may have succeeded while
                 the HTTP request was in flight.

                 Never overwrite it with IP coordinates.
                 */
                if
                    let current =
                        state.currentFix,

                    isCoreLocationSource(
                        current.source
                    )
                {
                    return false
                }

                state.currentFix =
                    ipFix

                state.locationError =
                    nil

                return true
            }

        persistState()

        guard accepted else {
            log(
                "Discarding IP coordinates because Core Location became available"
            )

            return
        }

        log(
            String(
                format:
                    "Using IP fallback %.6f, %.6f",
                latitude,
                longitude
            )
        )

        refreshOfflinePlace()
    }


    private func finishIPFailure(
        _ message:
            String
    ) {
        withState {
            $0.isResolvingIP =
                false

            $0.ipError =
                message
        }

        log(
            "IP fallback failed: \(message)"
        )
    }


    // MARK: API

    func json() -> Data {
        var snapshot =
            withState {
                $0
            }

        if
            snapshot.currentFix ==
                nil,

            !snapshot.isResolvingIP
        {
            resolveIPFallbackIfNeeded()

            snapshot =
                withState {
                    $0
                }
        }

        guard
            let fix =
                snapshot.currentFix
        else {
            var result:
                [String: Any] = [
                    "ok":
                        false,

                    "authorization":
                        authorizationString(
                            snapshot
                                .authorizationStatus
                        ),

                    "error":
                        snapshot
                            .locationError
                        ??
                        "Location unavailable",

                    "ip_status":
                        snapshot
                            .isResolvingIP
                        ?
                        "resolving"
                        :
                        "idle"
                ]

            if
                let ipError =
                    snapshot.ipError
            {
                result[
                    "ip_error"
                ] =
                    ipError
            }

            return encodeJSON(
                result
            )
        }

        var result:
            [String: Any] = [
                "ok":
                    true,

                /*
                 This is the coordinate source.

                 It is independent from the
                 offline GeoNames geocoder.
                 */
                "source":
                    fix.source,

                "latitude":
                    fix.latitude,

                "longitude":
                    fix.longitude,

                "accuracy_m":
                    fix.horizontalAccuracy,

                "altitude_m":
                    fix.altitude,

                "age_seconds":
                    fix.age,

                "timestamp":
                    ISO8601DateFormatter()
                        .string(
                            from:
                                fix.timestamp
                        ),

                "authorization":
                    authorizationString(
                        snapshot
                            .authorizationStatus
                    ),

                "fresh_core_location":
                    snapshot
                        .receivedFreshCoreLocation,

                "geocoder":
                    geocoder
                    == nil
                    ?
                    "unavailable"
                    :
                    "geonames-offline"
            ]

        if
            let place =
                snapshot.currentPlace
        {
            result[
                "display_name"
            ] =
                place.displayName

            result[
                "place_source"
            ] =
                "geonames-offline"

            result[
                "nearest_place_distance_km"
            ] =
                place.distanceKilometers

            if
                let city =
                    place.city
            {
                result["city"] =
                    city
            }

            if
                let region =
                    place.region
            {
                result["region"] =
                    region
            }

            if
                let country =
                    place.country
            {
                result["country"] =
                    country
            }

            result[
                "country_code"
            ] =
                place.countryCode
        }

        if
            let warning =
                snapshot.locationError
        {
            result[
                "location_warning"
            ] =
                warning
        }

        if
            snapshot.isResolvingIP
        {
            result[
                "ip_status"
            ] =
                "resolving"

        } else if
            snapshot.lastIPLocation
            != nil
        {
            result[
                "ip_status"
            ] =
                "available"

        } else {
            result[
                "ip_status"
            ] =
                "idle"
        }

        if
            let error =
                snapshot.ipError
        {
            result[
                "ip_error"
            ] =
                error
        }

        return encodeJSON(
            result
        )
    }


    // MARK: Helpers

    private func isCoreLocationSource(
        _ source:
            String
    ) -> Bool {
        switch source {

        case "corelocation",
             "corelocation-system-cache",
             "cache-corelocation":

            return true

        default:
            return false
        }
    }


    private func authorizationString(
        _ status:
            CLAuthorizationStatus
    ) -> String {
        switch status {

        case .notDetermined:
            return "not_determined"

        case .restricted:
            return "restricted"

        case .denied:
            return "denied"

        case .authorizedAlways:
            return "authorized_always"

        case .authorizedWhenInUse:
            return "authorized_when_in_use"

        @unknown default:
            return "unknown"
        }
    }


    private func encodeJSON(
        _ object:
            [String: Any]
    ) -> Data {
        do {
            return try JSONSerialization
                .data(
                    withJSONObject:
                        object,

                    options: [
                        .prettyPrinted,
                        .sortedKeys
                    ]
                )

        } catch {
            log(
                "JSON encoding failed: \(error.localizedDescription)"
            )

            return Data(
                #"{"ok":false,"error":"JSON encoding failed"}"#.utf8
            )
        }
    }
}


// MARK: - HTTP Request

struct HTTPRequest {
    let method: String
    let target: String

    let headers:
        [String: String]

    var path: String {
        String(
            target.split(
                separator: "?",
                maxSplits: 1
            )
            .first
            ?? ""
        )
    }
}


// MARK: - HTTP Server

final class HTTPServer {
    private let configuration:
        Configuration

    private let locationProvider:
        LocationProvider

    private var serverFD:
        Int32 = -1


    init(
        configuration:
            Configuration,

        locationProvider:
            LocationProvider
    ) {
        self.configuration =
            configuration

        self.locationProvider =
            locationProvider
    }


    deinit {
        if
            serverFD >= 0
        {
            close(
                serverFD
            )
        }
    }


    // MARK: Start

    func start() throws {
        try validateRootDirectory()

        serverFD =
            socket(
                AF_INET,
                SOCK_STREAM,
                0
            )

        guard
            serverFD >= 0
        else {
            throw ServerError(
                "Unable to create socket"
            )
        }

        var enabled:
            Int32 = 1

        _ = setsockopt(
            serverFD,
            SOL_SOCKET,
            SO_REUSEADDR,

            &enabled,

            socklen_t(
                MemoryLayout<
                    Int32
                >.size
            )
        )

        _ = setsockopt(
            serverFD,
            SOL_SOCKET,
            SO_NOSIGPIPE,

            &enabled,

            socklen_t(
                MemoryLayout<
                    Int32
                >.size
            )
        )

        var address =
            sockaddr_in()

        address.sin_len =
            UInt8(
                MemoryLayout<
                    sockaddr_in
                >.size
            )

        address.sin_family =
            sa_family_t(
                AF_INET
            )

        address.sin_port =
            configuration
                .port
                .bigEndian

        /*
         Loopback only.
         */
        address.sin_addr =
            in_addr(
                s_addr:
                    inet_addr(
                        "127.0.0.1"
                    )
            )

        let bindResult =
            withUnsafePointer(
                to:
                    &address
            ) {
                pointer in

                pointer
                    .withMemoryRebound(
                        to:
                            sockaddr.self,

                        capacity:
                            1
                    )
                {
                    bind(
                        serverFD,
                        $0,

                        socklen_t(
                            MemoryLayout<
                                sockaddr_in
                            >.size
                        )
                    )
                }
            }

        guard
            bindResult == 0
        else {
            throw ServerError(
                "Unable to bind 127.0.0.1:\(configuration.port): \(errnoDescription())"
            )
        }

        guard
            listen(
                serverFD,
                64
            ) == 0
        else {
            throw ServerError(
                "Unable to listen: \(errnoDescription())"
            )
        }

        log(
            """
            Wallserve running
            URL: http://127.0.0.1:\(configuration.port)/
            Root: \(configuration.root.path)
            Location: http://127.0.0.1:\(configuration.port)/api/location
            """
        )

        DispatchQueue
            .global(
                qos:
                    .userInitiated
            )
            .async {
                [weak self] in

                self?
                    .acceptLoop()
            }
    }


    // MARK: Accept

    private func acceptLoop() {
        while
            serverFD >= 0
        {
            var clientAddress =
                sockaddr_storage()

            var length =
                socklen_t(
                    MemoryLayout<
                        sockaddr_storage
                    >.size
                )

            let clientFD =
                withUnsafeMutablePointer(
                    to:
                        &clientAddress
                ) {
                    pointer in

                    pointer
                        .withMemoryRebound(
                            to:
                                sockaddr.self,

                            capacity:
                                1
                        )
                    {
                        accept(
                            serverFD,
                            $0,
                            &length
                        )
                    }
                }

            if
                clientFD < 0
            {
                if errno != EINTR {
                    log(
                        "accept() failed: \(errnoDescription())"
                    )
                }

                continue
            }

            var enabled:
                Int32 = 1

            _ = setsockopt(
                clientFD,
                SOL_SOCKET,
                SO_NOSIGPIPE,

                &enabled,

                socklen_t(
                    MemoryLayout<
                        Int32
                    >.size
                )
            )

            DispatchQueue
                .global(
                    qos:
                        .utility
                )
                .async {
                    [weak self] in

                    self?
                        .handleClient(
                            clientFD
                        )
                }
        }
    }


    // MARK: Client

    private func handleClient(
        _ fd:
            Int32
    ) {
        defer {
            close(
                fd
            )
        }

        guard
            let request =
                readRequest(
                    fd
                )
        else {
            sendSimpleError(
                fd,

                status:
                    400,

                message:
                    "Bad Request"
            )

            return
        }

        guard
            isAllowedHost(
                request
                    .headers[
                        "host"
                    ]
            )
        else {
            sendResponse(
                fd,

                status:
                    403,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Forbidden".utf8
                    ),

                request:
                    request
            )

            return
        }

        switch
            request
                .method
                .uppercased()
        {
        case "GET",
             "HEAD":

            route(
                request,
                fd:
                    fd
            )


        case "OPTIONS":

            sendResponse(
                fd,

                status:
                    204,

                contentType:
                    "text/plain",

                body:
                    Data(),

                request:
                    request
            )


        default:

            sendResponse(
                fd,

                status:
                    405,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Method Not Allowed".utf8
                    ),

                request:
                    request
            )
        }
    }


    // MARK: Routes

    private func route(
        _ request:
            HTTPRequest,

        fd:
            Int32
    ) {
        switch
            request.path
        {
        case "/api/health":

            sendResponse(
                fd,

                status:
                    200,

                contentType:
                    "application/json; charset=utf-8",

                body:
                    Data(
                        #"{"ok":true}"#.utf8
                    ),

                request:
                    request,

                extraHeaders: [
                    "Cache-Control":
                        "no-store"
                ]
            )


        case "/api/location":

            sendResponse(
                fd,

                status:
                    200,

                contentType:
                    "application/json; charset=utf-8",

                body:
                    locationProvider
                        .json(),

                request:
                    request,

                extraHeaders: [
                    "Cache-Control":
                        "no-store"
                ]
            )


        default:

            if
                request
                    .path
                    .hasPrefix(
                        "/api/"
                    )
            {
                sendResponse(
                    fd,

                    status:
                        404,

                    contentType:
                        "application/json; charset=utf-8",

                    body:
                        Data(
                            #"{"ok":false,"error":"Not Found"}"#.utf8
                        ),

                    request:
                        request
                )

                return
            }

            serveStatic(
                request,
                fd:
                    fd
            )
        }
    }


    // MARK: Static Files

    private func serveStatic(
        _ request:
            HTTPRequest,

        fd:
            Int32
    ) {
        guard
            let decoded =
                request
                    .path
                    .removingPercentEncoding
        else {
            sendResponse(
                fd,

                status:
                    400,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Bad Path".utf8
                    ),

                request:
                    request
            )

            return
        }

        guard
            !decoded
                .contains(
                    "\0"
                )
        else {
            sendResponse(
                fd,

                status:
                    400,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Bad Path".utf8
                    ),

                request:
                    request
            )

            return
        }

        var relative =
            decoded

        if relative == "/" {
            relative =
                "index.html"
        } else {
            relative =
                relative
                    .trimmingCharacters(
                        in:
                            CharacterSet(
                                charactersIn:
                                    "/"
                            )
                    )
        }

        var fileURL =
            configuration
                .root
                .appendingPathComponent(
                    relative
                )
                .standardizedFileURL
                .resolvingSymlinksInPath()

        guard
            isInsideRoot(
                fileURL
            )
        else {
            sendResponse(
                fd,

                status:
                    403,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Forbidden".utf8
                    ),

                request:
                    request
            )

            return
        }

        var isDirectory =
            ObjCBool(
                false
            )

        let exists =
            FileManager
                .default
                .fileExists(
                    atPath:
                        fileURL.path,

                    isDirectory:
                        &isDirectory
                )

        if
            exists,
            isDirectory
                .boolValue
        {
            fileURL =
                fileURL
                    .appendingPathComponent(
                        "index.html"
                    )
                    .standardizedFileURL
                    .resolvingSymlinksInPath()
        }

        guard
            isInsideRoot(
                fileURL
            )
        else {
            sendResponse(
                fd,

                status:
                    403,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Forbidden".utf8
                    ),

                request:
                    request
            )

            return
        }

        guard
            FileManager
                .default
                .isReadableFile(
                    atPath:
                        fileURL.path
                )
        else {
            sendResponse(
                fd,

                status:
                    404,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Not Found".utf8
                    ),

                request:
                    request
            )

            return
        }

        do {
            let data =
                try Data(
                    contentsOf:
                        fileURL,

                    options:
                        [.mappedIfSafe]
                )

            sendResponse(
                fd,

                status:
                    200,

                contentType:
                    mimeType(
                        for:
                            fileURL
                    ),

                body:
                    data,

                request:
                    request,

                extraHeaders: [
                    "Cache-Control":
                        "no-cache"
                ]
            )

        } catch {
            sendResponse(
                fd,

                status:
                    500,

                contentType:
                    "text/plain; charset=utf-8",

                body:
                    Data(
                        "Internal Server Error".utf8
                    ),

                request:
                    request
            )
        }
    }


    private func isInsideRoot(
        _ url:
            URL
    ) -> Bool {
        let root =
            configuration
                .root
                .path

        let candidate =
            url.path

        return (
            candidate ==
                root
            ||
            candidate
                .hasPrefix(
                    root + "/"
                )
        )
    }


    // MARK: HTTP Parsing

    private func readRequest(
        _ fd:
            Int32
    ) -> HTTPRequest? {
        let terminator =
            Data(
                "\r\n\r\n".utf8
            )

        var data =
            Data()

        while
            data.count <
                16_384
        {
            var buffer =
                [UInt8](
                    repeating:
                        0,

                    count:
                        4_096
                )

            let count =
                buffer
                    .withUnsafeMutableBytes {
                        rawBuffer in

                        recv(
                            fd,

                            rawBuffer
                                .baseAddress,

                            rawBuffer
                                .count,

                            0
                        )
                    }

            guard
                count > 0
            else {
                return nil
            }

            data.append(
                contentsOf:
                    buffer
                        .prefix(
                            count
                        )
            )

            if
                data.range(
                    of:
                        terminator
                ) != nil
            {
                break
            }
        }

        guard
            let text =
                String(
                    data:
                        data,

                    encoding:
                        .utf8
                )
        else {
            return nil
        }

        let lines =
            text
                .components(
                    separatedBy:
                        "\r\n"
                )

        guard
            let first =
                lines.first
        else {
            return nil
        }

        let parts =
            first.split(
                separator:
                    " ",

                maxSplits:
                    2
            )

        guard
            parts.count >= 2
        else {
            return nil
        }

        var headers:
            [String: String] =
                [:]

        for line in
            lines.dropFirst()
        {
            if line.isEmpty {
                break
            }

            guard
                let separator =
                    line.firstIndex(
                        of:
                            ":"
                    )
            else {
                continue
            }

            let key =
                line[
                    ..<separator
                ]
                .trimmingCharacters(
                    in:
                        .whitespaces
                )
                .lowercased()

            let value =
                line[
                    line.index(
                        after:
                            separator
                    )...
                ]
                .trimmingCharacters(
                    in:
                        .whitespaces
                )

            headers[
                key
            ] =
                value
        }

        return HTTPRequest(
            method:
                String(
                    parts[0]
                ),

            target:
                String(
                    parts[1]
                ),

            headers:
                headers
        )
    }


    // MARK: Response

    private func sendResponse(
        _ fd:
            Int32,

        status:
            Int,

        contentType:
            String,

        body:
            Data,

        request:
            HTTPRequest,

        extraHeaders:
            [String: String] =
                [:]
    ) {
        var headers:
            [String: String] = [
                "Content-Type":
                    contentType,

                "Content-Length":
                    String(
                        body.count
                    ),

                "Connection":
                    "close",

                "X-Content-Type-Options":
                    "nosniff"
            ]

        for
            (key, value)
            in extraHeaders
        {
            headers[key] =
                value
        }

        var head =
            "HTTP/1.1 \(status) \(reasonPhrase(status))\r\n"

        for
            (key, value)
            in headers
        {
            head +=
                "\(key): \(value)\r\n"
        }

        head += "\r\n"

        writeAll(
            fd,

            Data(
                head.utf8
            )
        )

        if
            request
                .method
                .uppercased()
            != "HEAD"
        {
            writeAll(
                fd,
                body
            )
        }
    }


    private func sendSimpleError(
        _ fd:
            Int32,

        status:
            Int,

        message:
            String
    ) {
        let request =
            HTTPRequest(
                method:
                    "GET",

                target:
                    "/",

                headers: [
                    "host":
                        "127.0.0.1"
                ]
            )

        sendResponse(
            fd,

            status:
                status,

            contentType:
                "text/plain; charset=utf-8",

            body:
                Data(
                    message.utf8
                ),

            request:
                request
        )
    }


    private func writeAll(
        _ fd:
            Int32,

        _ data:
            Data
    ) {
        data.withUnsafeBytes {
            buffer in

            guard
                let base =
                    buffer
                        .baseAddress
            else {
                return
            }

            var offset =
                0

            while
                offset <
                    buffer.count
            {
                let count =
                    Darwin.send(
                        fd,

                        base.advanced(
                            by:
                                offset
                        ),

                        buffer.count -
                            offset,

                        0
                    )

                if count < 0 {
                    if
                        errno ==
                            EINTR
                    {
                        continue
                    }

                    return
                }

                if count == 0 {
                    return
                }

                offset +=
                    count
            }
        }
    }


    // MARK: Security

    private func isAllowedHost(
        _ value:
            String?
    ) -> Bool {
        guard
            let value
        else {
            return false
        }

        let host =
            value
                .lowercased()
                .trimmingCharacters(
                    in:
                        .whitespacesAndNewlines
                )

        return (
            host ==
                "127.0.0.1"

            ||

            host.hasPrefix(
                "127.0.0.1:"
            )

            ||

            host ==
                "localhost"

            ||

            host.hasPrefix(
                "localhost:"
            )
        )
    }


    // MARK: MIME

    private func mimeType(
        for url:
            URL
    ) -> String {
        switch
            url.pathExtension
                .lowercased()
        {
        case "html",
             "htm":

            return
                "text/html; charset=utf-8"

        case "js",
             "mjs":

            return
                "text/javascript; charset=utf-8"

        case "css":

            return
                "text/css; charset=utf-8"

        case "json":

            return
                "application/json; charset=utf-8"

        case "png":

            return "image/png"

        case "jpg",
             "jpeg":

            return "image/jpeg"

        case "webp":

            return "image/webp"

        case "svg":

            return "image/svg+xml"

        case "gif":

            return "image/gif"

        case "mp4":

            return "video/mp4"

        case "webm":

            return "video/webm"

        case "woff":

            return "font/woff"

        case "woff2":

            return "font/woff2"

        default:

            return
                "application/octet-stream"
        }
    }


    // MARK: Validation

    private func validateRootDirectory()
        throws
    {
        var isDirectory =
            ObjCBool(
                false
            )

        let exists =
            FileManager
                .default
                .fileExists(
                    atPath:
                        configuration
                            .root
                            .path,

                    isDirectory:
                        &isDirectory
                )

        guard
            exists,
            isDirectory
                .boolValue
        else {
            throw ServerError(
                "Static root does not exist: \(configuration.root.path)"
            )
        }
    }


    private func reasonPhrase(
        _ status:
            Int
    ) -> String {
        switch status {

        case 200:
            return "OK"

        case 204:
            return "No Content"

        case 400:
            return "Bad Request"

        case 403:
            return "Forbidden"

        case 404:
            return "Not Found"

        case 405:
            return "Method Not Allowed"

        case 500:
            return "Internal Server Error"

        default:
            return "Unknown"
        }
    }


    private func errnoDescription()
        -> String
    {
        String(
            cString:
                strerror(
                    errno
                )
        )
    }
}


// MARK: - Error

struct ServerError:
    LocalizedError
{
    let message:
        String

    init(
        _ message:
            String
    ) {
        self.message =
            message
    }

    var errorDescription:
        String?
    {
        message
    }
}

// MARK: - Application Entry Point

@main
struct WallserveApp {

    static func main() {

        let configuration =
            Configuration
                .fromArguments()

        // MARK: Load Offline GeoNames Database

        let geodataDirectory =
            findGeodataDirectory()

        let geocoder:
            GeoNamesGeocoder?

        do {
            let loaded =
                try GeoNamesGeocoder(
                    dataDirectory:
                        geodataDirectory
                )

            geocoder =
                loaded

            log(
                """
                GeoNames loaded successfully
                  Directory: \(geodataDirectory.path)
                  Populated places: \(loaded.cityCount)
                """
            )

        } catch {
            geocoder =
                nil

            log(
                """
                GeoNames unavailable
                  Directory: \(geodataDirectory.path)
                  Error: \(error.localizedDescription)
                """
            )
        }

        // MARK: Location Provider

        let locationProvider =
            LocationProvider(
                geocoder:
                    geocoder
            )

        // MARK: HTTP Server

        let server =
            HTTPServer(
                configuration:
                    configuration,

                locationProvider:
                    locationProvider
            )

        do {
            try server.start()

        } catch {
            log(
                "Fatal server error: \(error.localizedDescription)"
            )

            exit(EXIT_FAILURE)
        }

        /*
         Keep strong references alive.

         server and locationProvider must remain alive for
         the lifetime of the process.
         */
        withExtendedLifetime(
            (
                server,
                locationProvider
            )
        ) {
            /*
             CLLocationManager needs an active
             main run loop.
             */
            RunLoop.main.run()
        }
    }
}