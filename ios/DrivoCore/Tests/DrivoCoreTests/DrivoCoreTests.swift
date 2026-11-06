import XCTest
@testable import DrivoCore

// The same cases as android/core/src/test, so both apps follow the same rules.

private func fix(_ t: Int64, lon: Double = 178.4419, lat: Double = -18.1416, acc: Double = 5, mps: Double? = 10) -> Fix {
    Fix(timeMs: t, lon: lon, lat: lat, accuracyM: acc, speedMps: mps, headingDeg: 90)
}

/// 1 m of latitude in degrees.
private let M = 1.0 / 110_600

final class GeoTests: XCTestCase {
    func testMeasuresAcrossTheMeridianOnTaveuni() {
        let d = Geo.distance(LngLat(179.98, -16.79), LngLat(-179.88, -16.69))
        XCTAssert((14_000...20_000).contains(d), "was \(d)")
    }
}

final class FixFilterTests: XCTestCase {
    func testDropsFixesWorseThan30m() {
        XCTAssertEqual(FixFilter().accept(fix(0, acc: 31)), .dropped(.inaccurate))
        XCTAssertEqual(FixFilter().accept(fix(0, acc: 30)), .kept(fix(0, acc: 30)))
    }

    func testDropsImpossibleJumpsButKeepsFastDriving() {
        let f = FixFilter()
        _ = f.accept(fix(0))
        XCTAssertEqual(f.accept(fix(4_000, lat: -18.1416 + 2000 * M)), .dropped(.impossibleJump))
        if case .dropped = f.accept(fix(4_000, lat: -18.1416 + 100 * M)) { XCTFail("90 km/h should be kept") }
    }

    func testDropsOutOfOrderFixes() {
        let f = FixFilter()
        _ = f.accept(fix(10_000))
        XCTAssertEqual(f.accept(fix(9_000)), .dropped(.outOfOrder))
    }

    func testAllowsCrossingTheMeridianAtNormalSpeed() {
        let f = FixFilter()
        _ = f.accept(fix(0, lon: 179.9999, lat: -16.8))
        if case .dropped = f.accept(fix(4_000, lon: -179.9999, lat: -16.8)) { XCTFail("crossing the meridian is not a jump") }
    }
}

final class SamplingPolicyTests: XCTestCase {
    func testFourSecondsMovingAndFortyFiveAfterAMinuteStill() {
        let p = SamplingPolicy()
        XCTAssertEqual(p.intervalMs, 4_000)
        p.onFix(fix(0, mps: 0.2))
        p.onFix(fix(30_000, mps: 0))
        XCTAssertEqual(p.intervalMs, 4_000)
        XCTAssertTrue(p.onFix(fix(60_000, mps: 0.1)))
        XCTAssertEqual(p.intervalMs, 45_000)
        XCTAssertTrue(p.onFix(fix(65_000, mps: 6)))
        XCTAssertEqual(p.intervalMs, 4_000)
    }
}

final class PointBatcherTests: XCTestCase {
    func testClosesABatchEvery45SecondsWithAPhoneMadeId() {
        var n = 0
        let b = PointBatcher(newId: { n += 1; return "batch-\(n)" })
        for t in stride(from: Int64(0), to: 44_000, by: 4_000) { XCTAssertNil(b.add(fix(t))) }
        let batch = b.add(fix(48_000))
        XCTAssertEqual(batch?.id, "batch-1")
        XCTAssertEqual(batch?.points.count, 12)
        XCTAssertEqual(batch?.points.last?.wire, [48_000, 178.4419, -18.1416, 5, 10, 90])
        XCTAssertNil(b.flush())
    }
}

final class SpeedMonitorTests: XCTestCase {
    func testAlertsAfterTenSecondsOverTheLimit() {
        let s = SpeedMonitor()
        let over = 60 / 3.6
        XCTAssertFalse(s.onFix(fix(0, mps: over), limitKmh: 50).alert)
        XCTAssertTrue(s.onFix(fix(4_000, mps: over), limitKmh: 50).over)
        XCTAssertFalse(s.onFix(fix(8_000, mps: over), limitKmh: 50).alert)
        XCTAssertTrue(s.onFix(fix(12_000, mps: over), limitKmh: 50).alert)
        XCTAssertFalse(s.onFix(fix(16_000, mps: 40 / 3.6), limitKmh: 50).over)
    }
}

final class SpeedLimitsTests: XCTestCase {
    private func box(_ w: Double, _ s: Double, _ e: Double, _ n: Double) -> [[LngLat]] {
        [[LngLat(w, s), LngLat(e, s), LngLat(e, n), LngLat(w, n), LngLat(w, s)]]
    }

    func testUrbanInTownLowestWhereZonesOverlapHighwayOutside() {
        let limits = SpeedLimits(urbanKmh: 50, highwayKmh: 80, zones: [
            .init(name: "Greater Suva", limitKmh: nil, polygons: [box(178.40, -18.17, 178.53, -18.07)]),
            .init(name: "School", limitKmh: 30, polygons: [box(178.44, -18.143, 178.444, -18.14)]),
        ])
        XCTAssertEqual(limits.at(LngLat(178.4258, -18.1398)).kmh, 50)
        XCTAssertEqual(limits.at(LngLat(178.4419, -18.1416)), .init(kmh: 30, zone: "School"))
        XCTAssertEqual(limits.at(LngLat(178.52, -18.055)).kmh, 80)
    }
}

final class ArrivalDetectorTests: XCTestCase {
    private let shop = LngLat(178.4519, -18.1416)

    func testArrivesAfterTwoFixesInside50mOnce() {
        let a = ArrivalDetector(target: shop)
        XCTAssertEqual(a.onFix(fix(0, lon: 178.4519, lat: -18.1416 + 200 * M)), .none)
        XCTAssertEqual(a.onFix(fix(4_000, lon: 178.4519, lat: -18.1416 + 30 * M)), .none)
        XCTAssertEqual(a.onFix(fix(8_000, lon: 178.4519, lat: -18.1416 + 20 * M)), .arrived)
        XCTAssertEqual(a.onFix(fix(12_000, lon: 178.4519, lat: -18.1416 + 10 * M)), .none)
    }

    func testNotHereYetWaitsUntilTheDriverLeavesAndComesBack() {
        let a = ArrivalDetector(target: shop)
        _ = a.onFix(fix(0, lon: 178.4519, lat: -18.1416 + 20 * M))
        XCTAssertEqual(a.onFix(fix(4_000, lon: 178.4519, lat: -18.1416 + 10 * M)), .arrived)
        a.notHereYet()
        XCTAssertEqual(a.onFix(fix(8_000, lon: 178.4519, lat: -18.1416 + 10 * M)), .none)
        _ = a.onFix(fix(20_000, lon: 178.4519, lat: -18.1416 + 300 * M))
        _ = a.onFix(fix(40_000, lon: 178.4519, lat: -18.1416 + 20 * M))
        XCTAssertEqual(a.onFix(fix(44_000, lon: 178.4519, lat: -18.1416 + 10 * M)), .arrived)
    }
}
