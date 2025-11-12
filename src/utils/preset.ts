const preset: Record<string, (text: string) => string> = {
    fls: (text: string) => {
        const obj = JSON.parse(text)
        const time = new Date(obj._datetime_).toLocaleString()
        return time + ' ' + obj._level_.toUpperCase() + ' ' + obj._msg_
    }
}

export default preset