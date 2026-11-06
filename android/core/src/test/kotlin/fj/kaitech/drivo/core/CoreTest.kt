package fj.kaitech.drivo.core

import fj.kaitech.drivo.core.arrival.ArrivalDetector
import fj.kaitech.drivo.core.geo.Geo
import fj.kaitech.drivo.core.geo.LngLat
import fj.kaitech.drivo.core.tracking.Fix
import fj.kaitech.drivo.core.tracking.FixFilter
import fj.kaitech.drivo.core.tracking.PointBatcher
import fj.kaitech.drivo.core.tracking.SamplingPolicy
import fj.kaitech.drivo.core.tracking.SpeedMonitor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun fix(t: Long, lon: Double = 178.4419, lat: Double = -18.1416, acc: Double = 5.0, mps: Double? = 10.0) =
    Fix(t, lon, lat, acc, mps, 90.0)

/** 1 m of latitude in degrees. */
private const val M = 1.0 / 110_600

class GeoTest {
    @Test fun `measures across the 180 degree meridian on Taveuni`() {
        val d = Geo.distance(LngLat(179.98, -16.79), LngLat(-179.88, -16.69))
        assertTrue(d in 14_000.0..20_000.0, "was $d")
    }
}

class FixFilterTest {
    @Test fun `drops fixes worse than 30 m`() {
        assertIs<FixFilter.Result.Dropped>(FixFilter().accept(fix(0, acc = 31.0)))
        assertIs<FixFilter.Result.Kept>(FixFilter().accept(fix(0, acc = 30.0)))
    }

    @Test fun `drops impossible jumps but keeps fast driving`() {
        val f = FixFilter()
        f.accept(fix(0))
        // 2 km in 4 seconds is 500 m/s.
        assertEquals(FixFilter.Result.Dropped(FixFilter.Reason.IMPOSSIBLE_JUMP), f.accept(fix(4_000, lat = -18.1416 + 2000 * M)))
        // 100 m in 4 seconds is 90 km/h: fine.
        assertIs<FixFilter.Result.Kept>(f.accept(fix(4_000, lat = -18.1416 + 100 * M)))
    }

    @Test fun `drops out of order fixes`() {
        val f = FixFilter()
        f.accept(fix(10_000))
        assertEquals(FixFilter.Result.Dropped(FixFilter.Reason.OUT_OF_ORDER), f.accept(fix(9_000)))
    }

    @Test fun `allows a jump across the 180 degree meridian at normal speed`() {
        val f = FixFilter()
        f.accept(fix(0, lon = 179.9999, lat = -16.8))
        assertIs<FixFilter.Result.Kept>(f.accept(fix(4_000, lon = -179.9999, lat = -16.8)))
    }
}

class SamplingPolicyTest {
    @Test fun `samples every 4 s moving and 45 s after a minute still`() {
        val p = SamplingPolicy()
        assertEquals(4_000, p.intervalMs)
        p.onFix(fix(0, mps = 0.2))
        p.onFix(fix(30_000, mps = 0.0))
        assertEquals(4_000, p.intervalMs)
        assertTrue(p.onFix(fix(60_000, mps = 0.1)))
        assertEquals(45_000, p.intervalMs)
        assertTrue(p.onFix(fix(65_000, mps = 6.0)))
        assertEquals(4_000, p.intervalMs)
    }
}

class PointBatcherTest {
    @Test fun `closes a batch every 45 seconds with a phone-made id`() {
        var n = 0
        val b = PointBatcher(newId = { "batch-${++n}" })
        for (t in 0L until 44_000L step 4_000L) assertNull(b.add(fix(t)))
        val batch = assertNotNull(b.add(fix(48_000)))
        assertEquals("batch-1", batch.id)
        assertEquals(12, batch.points.size)
        assertEquals(listOf<Number>(48_000L, 178.4419, -18.1416, 5.0, 10.0, 90.0), batch.points.last().toWire())
        assertNull(b.flush())
    }
}

class SpeedMonitorTest {
    @Test fun `alerts after 10 seconds over the limit`() {
        val s = SpeedMonitor()
        val over = 60 / 3.6
        assertEquals(false, s.onFix(fix(0, mps = over), 50).alert)
        assertEquals(true, s.onFix(fix(4_000, mps = over), 50).over)
        assertEquals(false, s.onFix(fix(8_000, mps = over), 50).alert)
        assertEquals(true, s.onFix(fix(12_000, mps = over), 50).alert)
        assertEquals(false, s.onFix(fix(16_000, mps = 40 / 3.6), 50).over)
    }
}

class ArrivalDetectorTest {
    private val shop = LngLat(178.4519, -18.1416)

    @Test fun `arrives after two fixes inside 50 m, once`() {
        val a = ArrivalDetector(shop)
        assertEquals(ArrivalDetector.Event.NONE, a.onFix(fix(0, lon = 178.4519, lat = -18.1416 + 200 * M)))
        assertEquals(ArrivalDetector.Event.NONE, a.onFix(fix(4_000, lon = 178.4519, lat = -18.1416 + 30 * M)))
        assertEquals(ArrivalDetector.Event.ARRIVED, a.onFix(fix(8_000, lon = 178.4519, lat = -18.1416 + 20 * M)))
        assertEquals(ArrivalDetector.Event.NONE, a.onFix(fix(12_000, lon = 178.4519, lat = -18.1416 + 10 * M)))
    }

    @Test fun `not here yet waits until the driver leaves and comes back`() {
        val a = ArrivalDetector(shop)
        a.onFix(fix(0, lon = 178.4519, lat = -18.1416 + 20 * M))
        assertEquals(ArrivalDetector.Event.ARRIVED, a.onFix(fix(4_000, lon = 178.4519, lat = -18.1416 + 10 * M)))
        a.notHereYet()
        assertEquals(ArrivalDetector.Event.NONE, a.onFix(fix(8_000, lon = 178.4519, lat = -18.1416 + 10 * M)))
        a.onFix(fix(20_000, lon = 178.4519, lat = -18.1416 + 300 * M))
        a.onFix(fix(40_000, lon = 178.4519, lat = -18.1416 + 20 * M))
        assertEquals(ArrivalDetector.Event.ARRIVED, a.onFix(fix(44_000, lon = 178.4519, lat = -18.1416 + 10 * M)))
    }
}

class SpeedLimitsTest {
    private fun box(w: Double, s: Double, e: Double, n: Double) =
        listOf(listOf(LngLat(w, s), LngLat(e, s), LngLat(e, n), LngLat(w, n), LngLat(w, s)))

    private val limits = fj.kaitech.drivo.core.tracking.SpeedLimits(
        urbanKmh = 50,
        highwayKmh = 80,
        zones = listOf(
            fj.kaitech.drivo.core.tracking.SpeedLimits.Zone("Greater Suva", null, listOf(box(178.40, -18.17, 178.53, -18.07))),
            fj.kaitech.drivo.core.tracking.SpeedLimits.Zone("School", 30, listOf(box(178.44, -18.143, 178.444, -18.14))),
        ),
    )

    @Test fun `urban inside a town, lowest where zones overlap, highway outside`() {
        assertEquals(50, limits.at(LngLat(178.4258, -18.1398)).kmh)
        assertEquals("School", limits.at(LngLat(178.4419, -18.1416)).zone)
        assertEquals(30, limits.at(LngLat(178.4419, -18.1416)).kmh)
        assertEquals(80, limits.at(LngLat(178.52, -18.055)).kmh)
    }
}
