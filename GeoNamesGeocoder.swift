import Foundation

struct OfflinePlace: Codable {
    let city: String?
    let region: String?
    let country: String?
    let countryCode: String

    let displayName: String
    let distanceKilometers: Double
}

final class GeoNamesGeocoder {

    enum GeoNamesError: LocalizedError {
        case missingFile(String)
        case noCitiesLoaded

        var errorDescription: String? {
            switch self {
            case .missingFile(let name):
                return "Missing GeoNames file: \(name)"

            case .noCitiesLoaded:
                return "GeoNames database contains no populated places"
            }
        }
    }

    private struct City {
        let name: String

        let latitude: Double
        let longitude: Double

        let countryCode: String
        let admin1Code: String?

        let population: Int
    }

    private let cities: [City]

    private let admin1Names: [String: String]
    private let countryNames: [String: String]

    let cityCount: Int

    init(dataDirectory: URL) throws {
        let countryURL =
            dataDirectory
                .appendingPathComponent(
                    "countryInfo.txt"
                )

        let adminURL =
            dataDirectory
                .appendingPathComponent(
                    "admin1CodesASCII.txt"
                )

        /*
         Prefer the Libya-specific database.

         If it isn't present, allow cities1000.txt
         as a more general alternative.
         */
        let libyaURL =
            dataDirectory
                .appendingPathComponent(
                    "LY.txt"
                )

        let cities1000URL =
            dataDirectory
                .appendingPathComponent(
                    "cities1000.txt"
                )

        guard
            FileManager.default.fileExists(
                atPath: countryURL.path
            )
        else {
            throw GeoNamesError
                .missingFile(
                    "countryInfo.txt"
                )
        }

        guard
            FileManager.default.fileExists(
                atPath: adminURL.path
            )
        else {
            throw GeoNamesError
                .missingFile(
                    "admin1CodesASCII.txt"
                )
        }

        let cityURL: URL

        if
            FileManager.default.fileExists(
                atPath: libyaURL.path
            )
        {
            cityURL =
                libyaURL

        } else if
            FileManager.default.fileExists(
                atPath:
                    cities1000URL.path
            )
        {
            cityURL =
                cities1000URL

        } else {
            throw GeoNamesError
                .missingFile(
                    "LY.txt or cities1000.txt"
                )
        }

        countryNames =
            try Self.loadCountries(
                from: countryURL
            )

        admin1Names =
            try Self.loadAdmin1Names(
                from: adminURL
            )

        cities =
            try Self.loadCities(
                from: cityURL
            )

        guard !cities.isEmpty else {
            throw GeoNamesError
                .noCitiesLoaded
        }

        cityCount =
            cities.count
    }


    // MARK: - Reverse Geocode

    func reverseGeocode(
        latitude: Double,
        longitude: Double
    ) -> OfflinePlace? {

        guard
            latitude.isFinite,
            longitude.isFinite
        else {
            return nil
        }

        var bestCity: City?
        var bestDistance =
            Double.greatestFiniteMagnitude

        for city in cities {
            let distance =
                Self.distanceKilometers(
                    latitude1: latitude,
                    longitude1: longitude,

                    latitude2:
                        city.latitude,

                    longitude2:
                        city.longitude
                )

            if distance <
                bestDistance
            {
                bestDistance =
                    distance

                bestCity =
                    city
            }
        }

        guard
            let city =
                bestCity
        else {
            return nil
        }

        let adminKey: String?

        if
            let adminCode =
                city.admin1Code,
            !adminCode.isEmpty
        {
            adminKey =
                "\(city.countryCode).\(adminCode)"
        } else {
            adminKey =
                nil
        }

        let region =
            adminKey.flatMap {
                admin1Names[$0]
            }

        let country =
            countryNames[
                city.countryCode
            ]

        let displayName =
            Self.makeDisplayName(
                city:
                    city.name,

                region:
                    region,

                country:
                    country
            )

        return OfflinePlace(
            city:
                city.name,

            region:
                region,

            country:
                country,

            countryCode:
                city.countryCode,

            displayName:
                displayName,

            distanceKilometers:
                bestDistance
        )
    }


    // MARK: - City Database

    private static func loadCities(
        from url: URL
    ) throws -> [City] {

        let content =
            try String(
                contentsOf: url,
                encoding: .utf8
            )

        var result:
            [City] = []

        result.reserveCapacity(
            10_000
        )

        content.enumerateLines {
            line,
            _ in

            let fields =
                line.split(
                    separator: "\t",
                    omittingEmptySubsequences:
                        false
                )

            /*
             GeoNames columns:

              0 geonameid
              1 name
              2 asciiname
              3 alternatenames
              4 latitude
              5 longitude
              6 feature class
              7 feature code
              8 country code
              9 cc2
             10 admin1
             ...
             14 population
             */

            guard
                fields.count >= 15
            else {
                return
            }

            /*
             Only populated places.

             This prevents the nearest result
             from being a mountain, road, wadi,
             building, etc.
             */
            guard
                fields[6] == "P"
            else {
                return
            }

            guard
                let latitude =
                    Double(
                        String(
                            fields[4]
                        )
                    ),

                let longitude =
                    Double(
                        String(
                            fields[5]
                        )
                    )
            else {
                return
            }

            let normalName =
                String(fields[1])

            let asciiName =
                String(fields[2])

            /*
             Prefer ASCII/transliterated city
             names for the wallpaper UI.
             */
            let name =
                asciiName.isEmpty
                ? normalName
                : asciiName

            let countryCode =
                String(fields[8])

            let admin1 =
                String(fields[10])

            let population =
                Int(
                    String(
                        fields[14]
                    )
                )
                ?? 0

            result.append(
                City(
                    name:
                        name,

                    latitude:
                        latitude,

                    longitude:
                        longitude,

                    countryCode:
                        countryCode,

                    admin1Code:
                        admin1.isEmpty
                        ? nil
                        : admin1,

                    population:
                        population
                )
            )
        }

        return result
    }


    // MARK: - Admin Regions

    private static func loadAdmin1Names(
        from url: URL
    ) throws -> [String: String] {

        let content =
            try String(
                contentsOf:
                    url,

                encoding:
                    .utf8
            )

        var result:
            [String: String] = [:]

        content.enumerateLines {
            line,
            _ in

            let fields =
                line.split(
                    separator: "\t",
                    omittingEmptySubsequences:
                        false
                )

            /*
             admin1CodesASCII:

             0 code e.g. LY.69
             1 name
             2 ascii name
             3 geonameid
             */

            guard
                fields.count >= 3
            else {
                return
            }

            let key =
                String(
                    fields[0]
                )

            let name =
                String(
                    fields[1]
                )

            let asciiName =
                String(
                    fields[2]
                )

            result[key] =
                asciiName.isEmpty
                ? name
                : asciiName
        }

        return result
    }


    // MARK: - Countries

    private static func loadCountries(
        from url: URL
    ) throws -> [String: String] {

        let content =
            try String(
                contentsOf:
                    url,

                encoding:
                    .utf8
            )

        var result:
            [String: String] = [:]

        content.enumerateLines {
            line,
            _ in

            if
                line.isEmpty ||
                line.hasPrefix("#")
            {
                return
            }

            let fields =
                line.split(
                    separator: "\t",
                    omittingEmptySubsequences:
                        false
                )

            /*
             countryInfo.txt:

             0 ISO
             1 ISO3
             2 ISO Numeric
             3 FIPS
             4 Country name
             ...
             */

            guard
                fields.count > 4
            else {
                return
            }

            let countryCode =
                String(
                    fields[0]
                )

            let countryName =
                String(
                    fields[4]
                )

            result[
                countryCode
            ] =
                countryName
        }

        return result
    }


    // MARK: - Display Name

    private static func makeDisplayName(
        city: String?,
        region: String?,
        country: String?
    ) -> String {

        /*
         For the wallpaper:

             Benghazi, Libya

         is nicer than:

             Benghazi, Banghazi, Libya

         Region is still exposed separately
         in the JSON API.
         */

        var parts:
            [String] = []

        var seen =
            Set<String>()

        for value in [
            city,
            country
        ] {
            guard
                let value
            else {
                continue
            }

            let cleaned =
                value.trimmingCharacters(
                    in:
                        .whitespacesAndNewlines
                )

            guard
                !cleaned.isEmpty
            else {
                continue
            }

            let key =
                cleaned.lowercased()

            guard
                !seen.contains(
                    key
                )
            else {
                continue
            }

            seen.insert(key)
            parts.append(cleaned)
        }

        if !parts.isEmpty {
            return parts.joined(
                separator: ", "
            )
        }

        return region ?? "Unknown"
    }


    // MARK: - Distance

    private static func distanceKilometers(
        latitude1: Double,
        longitude1: Double,

        latitude2: Double,
        longitude2: Double
    ) -> Double {

        /*
         Haversine distance.

         This is sufficient for selecting the
         nearest GeoNames populated place.
         */

        let earthRadius =
            6_371.0088

        let lat1 =
            latitude1 *
            .pi /
            180

        let lat2 =
            latitude2 *
            .pi /
            180

        let deltaLat =
            (latitude2 - latitude1)
            *
            .pi /
            180

        let deltaLon =
            (longitude2 - longitude1)
            *
            .pi /
            180

        let a =
            sin(deltaLat / 2)
            *
            sin(deltaLat / 2)
            +
            cos(lat1)
            *
            cos(lat2)
            *
            sin(deltaLon / 2)
            *
            sin(deltaLon / 2)

        let c =
            2
            *
            atan2(
                sqrt(a),
                sqrt(1 - a)
            )

        return earthRadius * c
    }
}