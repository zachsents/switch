import CoreLocation

/// Where the phone is, when the user has allowed it: one fix each time the app comes to the front,
/// as `iphone.located`. Asked once; never again once answered.
@MainActor
final class Places: NSObject, CLLocationManagerDelegate {
  static let shared = Places()

  private let manager = CLLocationManager()
  private weak var phone: Phone?

  func start(_ phone: Phone) {
    self.phone = phone
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    if manager.authorizationStatus == .notDetermined {
      manager.requestWhenInUseAuthorization()
    } else {
      look()
    }
  }

  func look() {
    let s = manager.authorizationStatus
    guard s == .authorizedWhenInUse || s == .authorizedAlways else { return }
    manager.requestLocation()
  }

  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    Task { @MainActor in self.look() }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let l = locations.last else { return }
    let (lat, lon, accuracy) = (l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy)
    Task { @MainActor in
      guard let phone = self.phone else { return }
      phone.emit(
        "iphone.located",
        ["device": .string(phone.device), "latitude": .number(lat), "longitude": .number(lon), "accuracy": .number(accuracy)])
    }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
