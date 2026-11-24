// What a part's checks found wrong (A2UI's `checks`), each under it as the house says what's wrong
// (ui/action-error.tsx): small, in red.
export const Problems = ({ errors }: { errors: readonly string[] | undefined }) =>
  errors?.map((e) => (
    <p key={e} role="alert" className="m-0 px-inset pb-1 text-small text-red">
      {e}
    </p>
  ))
