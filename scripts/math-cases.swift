// The iPhone's MathSplit against the cases every surface shares (packages/gateway/src/math/
// cases.json), compiled with it by scripts/math-cases.sh.
import Foundation

struct Case: Decodable {
  let `in`: String
  let out: [[String]]
}

let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var failed = 0
for c in cases {
  let got = MathSplit.split(c.in).map { [$0.kind.rawValue, $0.text] }
  if got != c.out {
    failed += 1
    print("FAIL \(c.in.debugDescription): \(got) != \(c.out)")
  }
}
print("swift: \(cases.count - failed)/\(cases.count)")
exit(failed == 0 ? 0 : 1)
