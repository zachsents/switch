// A2UI's basic catalog (v1.0), drawn in Switch's look: each part in its own file here, its properties
// A2UI's own (web_core's `TextApi` and the rest), with the catalog's functions (`formatString` and
// the rest) and its theme as A2UI's.
import { BASIC_FUNCTIONS, BasicCatalogThemeSchema, Catalog } from "@a2ui/web_core/v1_0"
import type { ReactComponentImplementation } from "@a2ui/react"
import { BASIC_CATALOG } from "switch-ext-kit"

import { AudioPlayer } from "./audio-player.tsx"
import { Button } from "./button.tsx"
import { Card } from "./card.tsx"
import { CheckBox } from "./check-box.tsx"
import { ChoicePicker } from "./choice-picker.tsx"
import { Column } from "./column.tsx"
import { DateTimeInput } from "./date-time-input.tsx"
import { Divider } from "./divider.tsx"
import { Icon } from "./icon.tsx"
import { Image } from "./image.tsx"
import { List } from "./list.tsx"
import { Modal } from "./modal.tsx"
import { Row } from "./row.tsx"
import { Slider } from "./slider.tsx"
import { Tabs } from "./tabs.tsx"
import { Text } from "./text.tsx"
import { TextField } from "./text-field.tsx"
import { Video } from "./video.tsx"

export const basic = new Catalog<ReactComponentImplementation>(
  BASIC_CATALOG,
  "1.0",
  [
    Text,
    Image,
    Icon,
    Video,
    AudioPlayer,
    Row,
    Column,
    List,
    Card,
    Tabs,
    Modal,
    Divider,
    Button,
    TextField,
    CheckBox,
    ChoicePicker,
    Slider,
    DateTimeInput,
  ],
  BASIC_FUNCTIONS,
  { themeSchema: BasicCatalogThemeSchema },
)
