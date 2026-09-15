-- ONGO :: locations — LocationApi (Step 10a)
--
-- The phone reports where it is; the server keeps the latest fix per user and
-- answers "which open jobs are near this mechanic". The contract is LocationApi
-- in on_go_shared (location_api.dart, geo_location.dart).
--
--   * user_locations — one row per user, replaced by each report: the point,
--     when the device took the fix, its accuracy, where the fix came from, the
--     reporter's side of the marketplace and, for a mechanic, availability.
--     Enum labels are the Dart enum names, which is what crosses the wire.
--   * ongo_great_circle_m — the haversine of GeoPoint.distanceTo, written once
--     so the nearby-jobs query and the tests measure the same way.
--
-- It also repairs booking coordinates stored as (0, 0): until this change the
-- request validator coerced `latitude: null` to 0. No On Go job sits at 0,0 in
-- the Gulf of Guinea, so those rows are nulls that went wrong.
--
-- No BEGIN/COMMIT: the runner wraps every file in one transaction.

CREATE TYPE location_source AS ENUM ('gps', 'lastKnown', 'manual');
CREATE TYPE location_role AS ENUM ('client', 'mechanic');
CREATE TYPE mechanic_availability AS ENUM ('available', 'onJob', 'offline');

CREATE TABLE user_locations (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Personal data: readable by the user, the console, and the other party of
    -- an active job, and nobody else (enforced in the query layer).
    latitude     double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude    double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    -- When the device took the fix, not when it was sent.
    recorded_at  timestamptz NOT NULL,
    accuracy_m   double precision CHECK (accuracy_m >= 0),
    source       location_source NOT NULL,
    role         location_role NOT NULL,
    availability mechanic_availability,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT user_locations_availability_is_for_mechanics
        CHECK (availability IS NULL OR role = 'mechanic')
);

-- Great-circle distance in meters, as GeoPoint.distanceTo computes it: haversine
-- on the mean earth radius (6371008.8 m), in the same order of operations.
CREATE OR REPLACE FUNCTION ongo_great_circle_m(
    lat1 double precision, lon1 double precision,
    lat2 double precision, lon2 double precision
) RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $fn$
    SELECT 2 * 6371008.8::double precision * asin(least(1.0::double precision, sqrt(
        sin((radians(lat2) - radians(lat1)) / 2) * sin((radians(lat2) - radians(lat1)) / 2)
        + cos(radians(lat1)) * cos(radians(lat2))
          * sin(radians(lon2 - lon1) / 2) * sin(radians(lon2 - lon1) / 2)
    )))
$fn$;

UPDATE service_requests
   SET latitude = NULL, longitude = NULL
 WHERE latitude = 0 AND longitude = 0;

-- Grants. Skipped when the roles do not exist.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_app') THEN
        GRANT SELECT, INSERT, UPDATE ON user_locations TO ongo_app;
        GRANT EXECUTE ON FUNCTION ongo_great_circle_m(double precision, double precision, double precision, double precision)
            TO ongo_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ongo_readonly') THEN
        GRANT SELECT ON user_locations TO ongo_readonly;
    END IF;
END
$$;
