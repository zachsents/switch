import { safeError } from "../../shared/safe-error.ts"

export const ActionError = ({ error }: { error: Error }) => (
  <p role="alert" className="basis-full text-small text-red">
    {safeError(error)}
  </p>
)
